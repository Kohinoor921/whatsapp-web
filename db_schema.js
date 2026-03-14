const dotenv = require('dotenv');
dotenv.config({ path: './keys.env' });
const mongoose = require('mongoose');


// ==========================================
// 1. CONNECTION & SETUP (FIXED)
// ==========================================


// ⚠️ STEP A: Put your password here
// Format must be: mongodb+srv://Username:Password@Hostname/
const BASE_URI = process.env.MONGO_URI;


const connectDB = async (env = "prod") => {
   // STEP B: Choose the bucket (QA vs Prod)
   const dbName = env === "qa" ? "kohinoor_qa" : "kohinoor_prod";
  
   // STEP C: Build the final string
   // It should look like: mongodb+srv://User:Pass@cluster...net/kohinoor_qa?retry...
   const fullURI = `${BASE_URI}${dbName}?retryWrites=true&w=majority`;


   console.log(`🔌 Attempting to connect to: ${dbName}...`); // Debug line


   try {
       await mongoose.connect(fullURI);
       console.log(`✅ DATABASE CONNECTED: ${dbName.toUpperCase()}`);
   } catch (err) {
       console.error("❌ Connection Failed. Check your URI string.");
       console.error("Error Detail:", err.message);
       process.exit(1);
   }
};


// ==========================================
// 2. SEQUENTIAL ID GENERATOR (The Engine)
// ==========================================
const CounterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', CounterSchema);


async function getNextSequence(name) {
   const ret = await Counter.findOneAndUpdate(
       { _id: name },
       { $inc: { seq: 1 } },
       { new: true, upsert: true }
   );
   return ret.seq;
}


// ==========================================
// 3. THE MODULES (Your Data Structure)
// ==========================================


// --- MODULE 3: GATED COMMUNITIES ---
const GCSchema = new mongoose.Schema({
   gc_id: { type: Number, unique: true },
   gc_code: { type: String, unique: true }, // "DLF_HYD"
   name: String,
   address: String,
   location_url: String,
   is_active: { type: Boolean, default: true }
},
{
   // 2️⃣ Force Mongoose to use your existing collection name
   collection: 'gatedcommunities'
});
GCSchema.pre('save', async function(next) {
   if (!this.gc_id) this.gc_id = await getNextSequence('gc_id');
});


const CustomerSchema = new mongoose.Schema({
   customer_id: { type: Number, unique: true },
   primary_phone: { type: String, required: true, unique: true },
   head_of_family_name: String,
   total_members: { type: Number, default: 1 },
   language: { type: String, default: "English" },
  
   // Address
   gc_id: String,
   block: String,
   flat: String,


   // ✅ NEW FIELD ADDED HERE
   onboarding_step: { type: String, default: "INIT" },
  
   created_at: { type: Date, default: Date.now }
});
CustomerSchema.pre('save', async function(next) {
   if (!this.customer_id) this.customer_id = await getNextSequence('customer_id');
});


// --- MODULE 2: MEMBERS (Individuals) ---
const MemberSchema = new mongoose.Schema({
   member_id: { type: String, unique: true }, // "MEM_1001_1"
   customer_id: Number, // Links to Family
  
   name: String,
   age: Number,
   gender: String,
   individual_phone: String,
  
   // 1-Onboarding, 2-Onboarded, 3-Delivery, 4-Pause, 5-Dropped
   status: { type: Number, default: 1, enum: [1, 2, 3, 4, 5] },
});


// --- MODULE 4: DELIVERY PARTNERS ---
const DeliveryPartnerSchema = new mongoose.Schema({
   partner_id: { type: Number, unique: true },
   phone: { type: String, required: true, unique: true },
   name: String,
   locality: String,
   kyc_document_link: String,
   is_verified: { type: Boolean, default: false },
   is_active: { type: Boolean, default: true }
});
DeliveryPartnerSchema.pre('save', async function(next) {
   if (!this.partner_id) this.partner_id = await getNextSequence('partner_id');
});


// --- MODULE 5: INVENTORY ---
const InventorySchema = new mongoose.Schema({
   item_id: { type: Number, unique: true },
   type: String, // "FRUITS", "NUTS"
   name: String,
   unit: { type: String, default: "kg" },
   current_stock: { type: Number, default: 0 }
});
InventorySchema.pre('save', async function(next) {
   if (!this.item_id) this.item_id = await getNextSequence('item_id');
});


// --- MODULE 6: ORDERS (Family Level) ---
const OrderSchema = new mongoose.Schema({
   order_id: { type: Number, unique: true },
  
   // LINKING (Family Level Only)
   customer_phone: { type: String, required: true },
   delivery_executive_id: { type: Number, ref: 'DeliveryPartner' },


   // 🆕 DRAFT PRICING (The Options you offer)
   quote_weekly_price: Number,   // e.g., 1500
   quote_3m_price: Number,       // e.g., 13500
  
   // FINAL SELECTION (To track what they eventually clicked)
   selected_plan: String, // "WEEKLY" or "3_MONTHS"
  
   // DETAILS
   order_type_id: String, // "MEAL_BOX_NOV"
  
   // STATUS UPDATE: Added 'draft' and 'pending_payment'
   order_status: {
       type: String,
       default: "draft", // Starts here until they choose
       enum: ["draft", "pending_payment", "scheduled", "in_transit", "delivered", "cancelled"]
   },
  
   // DATES & SLOT
   scheduled_date: Date,
   slot: String, // "Morning"
  
   // FINANCIALS
   amount_due: Number, // Filled ONLY after they make a choice
   invoice_pdf_url: String,
  
   customer_remarks: String,
   created_at: { type: Date, default: Date.now }
});


// 🛠️ FIX: Removed 'next' to prevent the crash
OrderSchema.pre('save', async function() {
   if (!this.order_id) this.order_id = await getNextSequence('order_id');
});


// --- MODULE 7: PAYMENTS ---
const PaymentSchema = new mongoose.Schema({
   payment_local_id: { type: Number, unique: true },
  
   // LINKS
   order_id: { type: Number, ref: 'Order' },
   customer_id: Number,


   // 2. CLASSIFICATION (The 3 Types)
   payment_type: {
       type: String,
       required: true,
       enum: ["ONBOARDING", "ORDER", "SUBSCRIPTION"]
   },
  
   // RAZORPAY & STATUS
   razorpay_order_id: String,
   razorpay_payment_id: String,
   payment_link: String,
   payment_status: { type: String, default: "pending" },
  
   // MONEY
   amount_paid: Number,
   payment_date: Date
});
PaymentSchema.pre('save', async function(next) {
   if (!this.payment_local_id) this.payment_local_id = await getNextSequence('payment_local_id');
});


// --- MODULE 8: DOCUMENTS ---
const DocumentSchema = new mongoose.Schema({
   doc_id: String,
   customer_id: Number,
   member_id: String,  
  
   doc_type: String, // "DIET_CHART", "BLOOD_REPORT"
   s3_url: { type: String, required: true },
  
   is_current: { type: Boolean, default: true },
   valid_from: Date,
   valid_until: Date,
   uploaded_at: { type: Date, default: Date.now }
});


// --- MODULE 9: TICKETS ---
const SupportTicketSchema = new mongoose.Schema(
   { customer_phone: String, context_flow: String, status: { type: String, default: "OPEN" } ,
    ticket_type : {
       type: String,
       required: true,
       enum: ["ONBOARDING", "NUTRITION", "ORDER", "GENERAL"]
   },
created_at: { type: Date, default: Date.now }
});


// ==========================================
// 4. EXPORT MODELS
// ==========================================
const GC = mongoose.model('GatedCommunity', GCSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Member = mongoose.model('Member', MemberSchema);
const DeliveryPartner = mongoose.model('DeliveryPartner', DeliveryPartnerSchema);
const Inventory = mongoose.model('Inventory', InventorySchema);
const Order = mongoose.model('Order', OrderSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Document = mongoose.model('Document', DocumentSchema);
const SupportTicket = mongoose.model('SupportTicket', SupportTicketSchema);


module.exports = {
   connectDB,
   GC, Customer, Member,
   DeliveryPartner, Inventory,
   Order, Payment, Document, SupportTicket, Counter
};

