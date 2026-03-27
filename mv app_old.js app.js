require('dotenv').config({ path: './keys.env' });
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const Razorpay = require('razorpay');
const fs = require('fs');


// CUSTOM MODULES (Ensure these files exist in the same folder)
const { connectDB, GC, Customer, Order, SupportTicket, Counter, Payment } = require('./db_schema');
const { decryptRequest, encryptResponse } = require('./crypto_utils');


const app = express();
app.use(bodyParser.json());


// Paste this near the top of app.js
async function getNextSequence(name) {
   console.log(`🔢 Generating ID for sequence: ${name}...`);
  
   const ret = await Counter.findOneAndUpdate(
       { _id: name },
       { $inc: { seq: 1 } },
       { new: true, upsert: true }
   );
  
   console.log("🔢 Counter Result:", ret); // <--- CHECK THIS LOG
   return ret.seq;
}


// ==============================================================
// 1. CONFIGURATION & SETUP
// ==============================================================
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const META_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;


// Initialize Razorpay
const razorpay = new Razorpay({
   key_id: process.env.RAZORPAY_KEY_ID,
   key_secret: process.env.RAZORPAY_KEY_SECRET
});


// Connect to Database
connectDB("qa"); // Change to "prod" when ready


// ==============================================================
// 2. ENGINE 1: THE WEBHOOK (Reactive - User Triggers)
// Handles: Flow 1, 2, 3, 4, 5, 9 (Pause)
// ==============================================================
app.post('/webhook', async (req, res) => {
   const body = req.body;


   // --- STATUS UPDATES (Sent, Delivered, Read, Failed) ---
   if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.statuses) {
       const status = body.entry[0].changes[0].value.statuses[0];
       console.log(`📡 STATUS UPDATE: ${status.status}`);
      
       if (status.status === 'failed') {
           console.error("❌ MESSAGE FAILED:", JSON.stringify(status.errors, null, 2));
       }
       return res.sendStatus(200); // Important: Reply to Meta
   }


   if (!body.object) return res.sendStatus(404);


   if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      
       const message = body.entry[0].changes[0].value.messages[0];
       const senderPhone = message.from;
      
       // --- A. TEXT TRIGGERS (Flow 1) ---
       if (message.type === 'text') {
           const text = message.text.body.toLowerCase();


           // FLOW 1: QR Scan Logic
           if (text.includes("end-to-end health subscriptions")) {
               console.log(`🚀 Flow 1 Triggered by ${senderPhone}`);
               await sendWelcomeBrochure(senderPhone);
           }
       }


       // --- B. BUTTON CLICKS (Flow 2, 5, 9, Support) ---
       if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
           const btnId = message.interactive.button_reply.id;


           // FLOW 2: User clicked "Subscribe Now" -> Send Registration Form
           if (btnId === 'btn_subscribe_now') {
               await sendRegistrationFlow(senderPhone);
           }


           // FLOW 4 & 9: User clicked "Pay Now" -> Generate Link
           if (btnId === 'btn_pay_now' || btnId === 'btn_pay_now_delivery') {
               await generateAndSendPaymentLink(senderPhone);
           }


           // FLOW 9: User clicked "Pause"
           if (btnId === 'btn_pause_service') {
               await sendMessage(senderPhone, "Hi frensss till when stoppppp? (Reply with Date DD/MM)");
               // In a real app, you'd update DB state here to expect a date input next
           }
          
           // SUPPORT (Global Trigger)
           if (btnId === 'btn_support') {
               await createSupportTicket(senderPhone, "Button Click");
           }
       }
  
   // if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      
   //     const message = body.entry[0].changes[0].value.messages[0];
   //     const senderPhone = message.from;


   //     // 🕵️‍♂️ TRACKING LOG: SPY ON THE MESSAGE TYPE
   //     console.log("========================================");
   //     console.log(`📡 INCOMING WEBHOOK from ${senderPhone}`);
   //     console.log(`👉 Message Type: [ ${message.type} ]`);


   //     // If it's interactive, let's dig deeper to see the subtype
   //     if (message.type === 'interactive') {
   //         console.log(`👉 Interactive Sub-Type: [ ${message.interactive.type} ]`);
          
   //         // Log the raw content of the interaction
   //         if (message.interactive.nfm_reply) {
   //             console.log("📦 Payload (nfm_reply):", message.interactive.nfm_reply);
   //         } else if (message.interactive.button_reply) {
   //             console.log("📦 Payload (button_reply):", message.interactive.button_reply);
   //         }
   //     }
   //     console.log("========================================");
   // }
  
  
       // --- LOGGING FOR FINAL FLOW SUBMISSION ---




       if (message.type === 'interactive' && message.interactive.type === 'nfm_reply') {
   const reply = message.interactive.nfm_reply;
  
   // // 1. The Raw String
   console.log("------------------------------------------------");
   console.log("🏁 FINAL SUBMISSION DETECTED (Webhook)");
   console.log("📱 From:", senderPhone);
   console.log("📄 Raw Response JSON String:", reply.response_json);


   try {
       // 2. The Parsed Object (This is what you use to save to DB)
       const parsedData = JSON.parse(reply.response_json);
       console.log("📦 Parsed Data Object:", JSON.stringify(parsedData, null, 2));
   } catch (e) {
       console.error("❌ Error parsing response_json:", e.message);
   }
   console.log("------------------------------------------------");
}
       // --- C. FORM SUBMISSION (Flow 2 -> Flow 3) ---
       // if (message.type === 'interactive' && message.interactive.type === 'nfm_reply') {
       //     const reply = message.interactive.nfm_reply;
       //     const responseJson = JSON.parse(reply.response_json);
          
       //     // FLOW 3: Save Data to DB
       //     const customer = await saveCustomerToDB(senderPhone, responseJson);
          
       //     // Send Success Msg
       //     await sendMessage(senderPhone, `You’re in! Thank you for choosing Kohinoor Elite Living. 💎\nWe are setting up your personalized dashboard.`);
          
       //     // FLOW 4: Immediately Trigger Payment Template
       //     const amount = customer.total_members * 1500; // Example Rate calculation
       //     await sendPaymentTemplate(senderPhone, customer.head_of_family_name, amount);
       // }
   }
   res.sendStatus(200);
});


// ==============================================================
// WEBHOOK VERIFICATION (Meta "Handshake")
// ==============================================================
app.get('/webhook', (req, res) => {
   const mode = req.query['hub.mode'];
   const token = req.query['hub.verify_token'];
   const challenge = req.query['hub.challenge'];


   // Check if mode and token are in the query string
   if (mode && token) {
       // Check if the mode is subscribe and token is correct
       if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
           console.log('✅ WEBHOOK VERIFIED');
           res.status(200).send(challenge); // Respond with the challenge token
       } else {
           console.error('❌ VERIFICATION FAILED: Token mismatch');
           res.sendStatus(403);
       }
   } else {
       res.sendStatus(400); // Bad Request
   }
});


// ==============================================================
// 3. ENGINE 2: THE SCHEDULER (Proactive - Cron Job)
// Handles: Flow 9 (Weekly Deliveries)
// ==============================================================
// Schedule: Every Monday at 9:00 AM ('0 9 * * 1')
cron.schedule('0 9 * * 1', async () => {
   console.log('⏰ CRON JOB STARTED: Checking for Weekly Deliveries...');


   try {
       // 1. Find all Active Orders (Scheduled)
       const activeOrders = await Order.find({
           order_status: 'scheduled'
       });


       console.log(`found ${activeOrders.length} active orders.`);


       // 2. Loop & Trigger Flow 9 Template
       for (const order of activeOrders) {
          
           // Logic: Generate OTP
           const newOtp = Math.floor(1000 + Math.random() * 9000);
           const deliveryTime = order.slot || "Morning Slot";


           // Send Template
           await sendWeeklyDeliveryTemplate(
               order.customer_phone,
               "Valued Member", // Ideally fetch name from Customer table using ID
               deliveryTime,
               newOtp
           );
       }
   } catch (err) {
       console.error("❌ Cron Job Failed:", err.message);
   }
});


// ==============================================================
// 4. API ENDPOINTS (Flow Data & Payments)
// ==============================================================


// FLOW 2: Search Endpoint (Community List)
// ... imports and setup ...


// FLOW 2: Search Endpoint (Community List)
app.post('/flow-data', async (req, res) => {
   try {
       const privateKeyPem = fs.readFileSync(process.env.FLOW_PRIVATE_KEY, 'utf8');
       const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body, privateKeyPem, process.env.FLOW_PASSPHRASE);
      
       // 🛡️ SAFETY FIX: Default 'data' to {} if missing (prevents crash on Health Check)
       const screen = decryptedBody.screen;
       const data = decryptedBody.data || {};
      
       // Now it is safe to read properties
       const userAction = data.action_1 || data.action_2 || data.action_3 || "INIT";


       console.log("========================================");
       console.log(`🔍 INCOMING REQUEST FROM SCREEN: [${screen}]`);
       console.log(`👉 Action Detected: [${userAction}]`);
       console.log("📦 FULL DATA PAYLOAD:");
       console.log(JSON.stringify(data, null, 2));
       console.log("========================================");
       let responseData = {};


       // 1. HEALTH CHECK
       if (!screen || screen === "HEALTH_CHECK") {
           responseData = { data: { status: "active" } };
       }


       // 2. DETAILS SCREEN -> INIT_SEARCH
       else if (userAction === "INIT_SEARCH") {
           let initialCommunities = await GC.find({ is_active: true }).limit(10);
           //   const form = data.details_form;


           //   console.log("REAL NAME:", form?.input_name);
           //   console.log("REAL PHONE:", form?.input_phone);
           //   console.log("REAL MEMBERS:", form?.input_members);
          
           responseData = {
               screen: "COMMUNITY_SEARCH",
               data: {
                   // 🚨 PIPE: Save Screen 1 data to Screen 2 memory
                   saved_name: data.name_1,
                   saved_phone: data.phone_1,
                   saved_members: data.members_count_1,
                  
                   communities: initialCommunities.map(gc => ({
                       id: gc.gc_id.toString(), title: gc.name, description: gc.address
                   }))
               }
           };
       }


       // 3. SEARCH SCREEN -> SEARCH OR NEXT
       else if (userAction === "SEARCH_OR_NEXT") {
           const userSelection = data.selection_1;


           // A. If they selected a community -> Move to ADDRESS
           if (userSelection) {
               responseData = {
                   screen: "ADDRESS",
                   data: {
                       // 🚨 PIPE: Pass Screen 1 data (from history) to Screen 3
                       final_name: data.prev_name,
                       final_phone: data.prev_phone,
                       final_members: data.prev_members,
                       // Pass Screen 2 data to Screen 3
                       final_gc_id: userSelection
                   }
               };
           }
           // B. If no selection (Search query logic)
           else {
               const searchQuery = data.query_1 || "";
               const communities = await GC.find({ name: { $regex: searchQuery, $options: 'i' } }).limit(10);
               responseData = {
                   screen: "COMMUNITY_SEARCH",
                   data: {
                       // Keep the history alive even if they search again
                       saved_name: data.prev_name,
                       saved_phone: data.prev_phone,
                       saved_members: data.prev_members,
                      
                       communities: communities.map(gc => ({
                           id: gc.gc_id.toString(), title: gc.name, description: gc.address
                       }))
                   }
               };
           }
       }


       // 4. ADDRESS SCREEN -> FINAL SUBMIT
       else if (userAction === "SUBMIT_FORM") {
           console.log("📝 FINAL SUBMIT RECEIVED. Saving to DB...");


           let userPhone = data.final_phone;


           if (!userPhone) {
                console.error("❌ ERROR: No Phone Number Found!");
                // Handle error appropriately
           }


           if (userPhone.length === 10) {
               userPhone = "91" + userPhone;
           }
          
           // Construct Final Data Object
           const registrationData = {
               primary_phone: userPhone, // Secured Token
               head_of_family_name: data.final_name,
               total_members: parseInt(data.final_members || "1"),
               gc_id: data.final_gc_id,
               block: data.block, // From current form
               flat: data.flat,   // From current form
               onboarding_step: "COMPLETED"
           };


           // 2. Check if user already exists
           // (We use userPhone which we extracted from the flow_token earlier)
           let customer = await Customer.findOne({ primary_phone: userPhone });


           if (customer) {
               // --- SCENARIO A: EXISTING CUSTOMER ---
               // Just update their details, DO NOT touch the ID
               console.log(`🔄 Existing User found (${userPhone}). Updating...`);
              
               Object.assign(customer, registrationData); // Merge new details
               await customer.save();
              
               console.log(`✅ Updated Customer: ${customer.customer_id}`);


           } else {
               // --- SCENARIO B: NEW CUSTOMER ---
               // Generate next Sequence ID and Create
               console.log(`🆕 New User (${userPhone}). Generating ID...`);


               const nextId = await getNextSequence("customer_id"); // <--- YOUR FUNCTION
              
               customer = new Customer({
                   customer_id: nextId,      // Assign 1, 2, 3...
                   primary_phone: userPhone, // Unique Identifier
                   ...registrationData         // Spread the rest of the data
               });


               await customer.save();
               console.log(`✅ Created Customer with ID: ${nextId}`);
           }


           // // SAVE TO DB
           // await Customer.findOneAndUpdate(
           //     { primary_phone: registrationData.primary_phone },
           //     registrationData,
           //     { upsert: true, new: true }
           // );
           // console.log(`✅ SAVED: ${registrationData.head_of_family_name}`);


           // ============================================================
           // 🚀 TRIGGER PAYMENT LINK HERE
           // ============================================================
           // We do NOT await this. We let it run in the background so the
           // flow screen closes immediately without lagging.
           setTimeout(() => {
               console.log(`⏰ 15s Delay Over. Sending Payment Link to ${userPhone}...`);
               generateAndSendPaymentLink(userPhone).catch(err =>
                   console.error("Background Payment Trigger Failed:", err)
               );
           }, 10000); // 15000 ms = 15 Seconds


           // RETURN SUCCESS SCREEN
           responseData = {
               screen: "SUCCESS_SCREEN",
               data: {}
           };
       }


       // Encrypt & Send
       const { encrypted_flow_data } = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
       res.send(encrypted_flow_data);


   } catch (error) {
       console.error("Flow Error:", error.message);
       res.status(500).send();
   }
});


// app.post('/flow-data', async (req, res) => {
//     try {
//         const privateKeyPem = fs.readFileSync(process.env.FLOW_PRIVATE_KEY, 'utf8');


//         const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body, privateKeyPem, process.env.FLOW_PASSPHRASE);
      
//         const { screen, data, action } = decryptedBody; // Note: 'action' might be inside 'data' depending on how it's sent
      
//         // We look at data.action because we put it in the payload in the JSON
//         const userAction = action || data?.action || "INIT";
//         console.log("------------------------------------------------");
//         console.log(`📡 INCOMING REQUEST: Screen=[${screen}] Action=[${userAction}]`);
//         console.log("📦 PAYLOAD DATA:", JSON.stringify(decryptedBody, null, 2));
//         console.log("------------------------------------------------");
//         let responseData = {};
      
//         // 1. ✅ ADD THIS: Health Check & Initial Entry Fallback
//         // Meta's health check sends an empty screen or a specific ping
//         if (!screen || screen === "HEALTH_CHECK") {
//             responseData = {
//                 data: {
//                     status: "active" // This makes the Health Check turn green
//                 }
//             };
//         }
//        // 2. Screen 1 (DETAILS) Logic
//         // CHANGE: Catch "INIT_SEARCH" which you defined in your JSON Footer
//         else if (screen === "DETAILS") {
//             if (userAction === "data_exchange") {
//                 // Fetch initial communities to populate the RadioButtons on the next screen
//                 let initialCommunities = await GC.find({ is_active: true }).limit(10);


//                 console.log(`🔍 DB Query Found: ${initialCommunities.length} communities`);


//                 // 2. SAFETY CHECK: If DB is empty, provide the "Not Live" message
//                 // This prevents the "at least 1 option" crash
//                 if (initialCommunities.length === 0) {
//                     initialCommunities = [{
//                         gc_id: "no_service", // A dummy ID
//                         name: "We're not live yet",
//                         address: "We shall get back to you soon!"
//                     }];
//                 }
              
//                 responseData = {
//                     screen: "COMMUNITY_SEARCH", // 👈 This triggers the screen switch
//                     data: {
//                         communities: initialCommunities.map(gc => ({
//                             id: gc.gc_id.toString(),
//                             title: gc.name,
//                             description: gc.address
//                         }))
//                     }
//                 };
//             } else {
//                 // Initial load of DETAILS screen
//                 responseData = { screen: "DETAILS", data: {} };
//             }
//         }
//         // --- SCREEN 2 LOGIC: SEARCH OR NEXT ---
//         else if (screen === "COMMUNITY_SEARCH") {
          
//             // CASE A: User Selected a Community -> Move to Address Screen
//             // if (data.selection && data.selection !== "")
//            if (userAction === "data_exchange" )  {
//                 responseData = {
//                     screen: "ADDRESS", // Navigate to next screen
//                     data: {}
//                 };
//             }
//             // CASE B: User typed something -> Perform Search
//             else {
//                 const searchQuery = data.search_query || "";
              
//                 // Search DB
//                 const communities = await GC.find({
//                     name: { $regex: searchQuery, $options: 'i' },
//                     is_active: true
//                 }).limit(10);


//                 // Return Results to SAME screen
//                 responseData = {
//                     screen: "COMMUNITY_SEARCH",
//                     data: {
//                         communities: communities.map(gc => ({
//                             id: gc.gc_id.toString(),
//                             title: gc.name,
//                             description: gc.address
//                         }))
//                     }
//                 };
//             }
//         }


//         // --- FINAL SUBMISSION LOGIC ---
// else if (userAction === "complete") {
//     // 1. Extract the data (Matching the names in your JSON payload)
//     const registrationData = {
//         primary_phone: decryptedBody.from || senderPhone, // Ensure you have the phone number
//         head_of_family_name: data.name,
//         total_members: parseInt(data.members_count),
//         gc_id: data.gc_id,
//         block: data.block,
//         flat: data.flat,
//         onboarding_step: "COMPLETED"
//     };


//     // 2. Save to Database
//     await Customer.findOneAndUpdate(
//         { primary_phone: registrationData.primary_phone },
//         registrationData,
//         { upsert: true, new: true }
//     );


//     console.log(`✅ Final Registration Saved for: ${registrationData.head_of_family_name}`);


//     // 3. Close the Flow
//     responseData = {
//         data: {
//             extension_message_response: {
//                 params: {
//                     status: "success",
//                     message: "Registration Complete!"
//                 }
//             }
//         }
//     };
// }
//         // Encrypt & Send Response
//         const { encrypted_flow_data } = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
//         res.send(encrypted_flow_data);


//     } catch (error) {
//         console.error("Flow Data Error:", error.message);
//         res.status(500).send();
//     }
// });


// FLOW 6: Razorpay Webhook (Payment Success)
app.post('/razorpay-webhook', async (req, res) => {
   console.log("------------------------------------------------");
   console.log("🔔 WEBHOOK HIT RECEIVED!");
   // console.log("👉 Headers:", JSON.stringify(req.headers, null, 2));
   // console.log("📦 Body:", JSON.stringify(req.body, null, 2));
   // console.log("------------------------------------------------");
  
   res.json({ status: 'ok' });




   // In prod, verify signature here using req.headers['x-razorpay-signature']
   if (req.body.event === 'payment.captured') {
       const paymentData = req.body.payload.payment.entity;
       const notes = paymentData.notes || {};
       const customerPhone = paymentData.notes.customer_phone;
       const paymentType = notes.payment_type || "ONBOARDING"; // Extracted from Link generation
      
       // Update DB Logic: Mark Order as PAID
       console.log(`💰 Payment captured for ${customerPhone}`);
       // await Payment.create(...) -> You would save this to your Payment model here
      
       try {
           // 2. Find the Customer to link the ID
           const customer = await Customer.findOne({ primary_phone: customerPhone });


           if (customer) {
               // 3. Save to Payment Collection (New Schema)
               const newPayment = new Payment({
                   customer_id: customer.customer_id,
                   payment_type: paymentType, // "ONBOARDING", "ORDER", etc.
                  
                   razorpay_payment_id: paymentData.id,
                   razorpay_order_id: paymentData.order_id, // May be null for direct links
                   amount_paid: paymentData.amount / 100,   // Convert Paise to Rupees
                   payment_status: "captured",
                   payment_date: new Date()
               });


               console.log("📦 Payment Object Payload:", newPayment);


               await newPayment.save();
               console.log(`📝 Payment Record Saved: ID ${newPayment.payment_local_id}`);


               // 4. Handle Specific Logic based on Type
               if (paymentType === "ONBOARDING") {
                   // Update Customer Status
                   customer.subscription_status = "ACTIVE";
                   customer.onboarding_step = "PAYMENT_COMPLETED";
                   await customer.save();


                   // Send Specific Onboarding Success Message
                   setTimeout(async () => {
                       console.log(`⏰ Sending delayed success message to ${customerPhone}...`);
                       await sendMessage(customerPhone, "Your onboarding payment was successful. Our team will reach out to you shortly to schedule your onboarding call. Welcome aboard! 💎");
                   }, 10000); // 10000 milliseconds = 10 seconds


                   // C. Create Support Ticket (With Type ONBOARDING)
                   const contextString = `Schedule onboarding call (Dietician), Name: ${customer.head_of_family_name}, Phone: ${customerPhone}, Members: ${customer.total_members}, Paid: ₹${newPayment.amount_paid}`;
                  
                   const newTicket = new SupportTicket({
                       customer_phone: customerPhone,
                       context_flow: contextString,
                       status: "OPEN",
                       ticket_type: "ONBOARDING" // <--- ✅ Classification
                   });
                   await newTicket.save();


                   // D. Discord Alert (Routed to Onboarding Channel)
                   const discordMsg = `🚨 **NEW VIP SUBSCRIBER!** 💎\n\n👤 **Name:** ${customer.head_of_family_name}\n📱 **Phone:** ${customerPhone}\n👨‍👩‍👧 **Members:** ${customer.total_members}\n💰 **Amount:** ₹${newPayment.amount_paid}\n\n👉 **DETAILS:** ${contextString}`;
                  
                   // Pass "ONBOARDING" to route it to the correct channel
                   sendDiscordAlert(discordMsg, "ONBOARDING");
               }
               // Future: else if (paymentType === "ORDER") { ... update order status ... }


           } else {
               console.error(`❌ Webhook Error: Customer not found for ${customerPhone}`);
           }
       } catch (err) {
           console.error("❌ DB Error in Webhook:", err.message);
       }
   }


});


// ==============================================================
// 5. HELPER & BUSINESS LOGIC FUNCTIONS
// ==============================================================


// GENERIC SEND MESSAGE
async function sendMessage(to, text) {
   try {
       await axios.post(META_URL, {
           messaging_product: "whatsapp", to: to, type: "text", text: { body: text }
       }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
   } catch (err) { console.error("Send Msg Error"); }
}


// FLOW 1: WELCOME BROCHURE (No Template Version)
// Triggered by: User scanning QR code
async function sendWelcomeBrochure(to) {
   try {
       await axios.post(META_URL, {
           messaging_product: "whatsapp",
           to: to,
           type: "interactive",
           interactive: {
               type: "button",
              
               // 1. HEADER (The PDF or Image)
               header: {
                   type: "document",
                   document: {
                       link: "https://drive.google.com/uc?export=download&id=1dOoRtIkJcHbs_zbQ3QN1SO_fi4cS-M5V",
                       filename: "Kohinoor_Elite_Plan.pdf" // This shows on the user's phone
                   }
               },
              
               // 2. BODY (The Welcome Message)
               body: {
                   text: "Welcome to Kohinoor Elite Living! 💎\n\nWe provide end-to-end health subscriptions for your community. Check out our brochure above."
               },
              
               // 3. FOOTER (Optional small text)
               footer: {
                   text: "Tap below to join"
               },
              
               // 4. BUTTON (Triggers Flow 2)
               action: {
                   buttons: [
                       {
                           type: "reply",
                           reply: {
                               id: "btn_subscribe_now",
                               title: "Subscribe Now"
                           }
                       }
                   ]
               }
           }
       }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
      
       console.log(`✅ Sent Free-Form Brochure to ${to}`);
      
   } catch (err) {
       console.error("Welcome Error", err.response?.data || err.message);
   }
}


// SEND SUPPORT TICKETS


// HELPER: Send Alerts to Specific Discord Channels
async function sendDiscordAlert(message, type = "GENERAL") {
   let webhookUrl;


   // 🔀 ROUTING LOGIC
   if (type === "ONBOARDING") {
       webhookUrl = process.env.DISCORD_WEBHOOK_ONBOARDING;}
   //  else if (type === "NUTRITION") {
   //     webhookUrl = process.env.DISCORD_WEBHOOK_NUTRITION;
   // } else if (type === "ORDER") {
   //     webhookUrl = process.env.DISCORD_WEBHOOK_ORDER;
   // }
    else {
       webhookUrl = process.env.DISCORD_WEBHOOK_GENERAL; // Fallback
   }
  
   if (!webhookUrl) {
       console.warn(`⚠️ No Discord Webhook found for type: ${type}`);
       return;
   }


   try {
       await axios.post(webhookUrl, { content: message });
       console.log(`🔔 Discord Alert Sent [Channel: ${type}]`);
   } catch (err) {
       console.error("❌ Discord Alert Failed:", err.message);
   }
}


// FLOW 2: SEND REGISTRATION FORM
async function sendRegistrationFlow(to) {
   try {
       await axios.post(META_URL, {
           messaging_product: "whatsapp", to: to, type: "interactive",
           interactive: {
               type: "flow", header: { type: "text", text: "Join Kohinoor Elite" },
               body: { text: "Please fill in your details." },
               footer: { text: "Secure & Fast" },
               action: {
                   name: "flow",
                   parameters: {
                       flow_message_version: "3",
                       flow_token: "REG_${Date.now()}",
                       flow_id: process.env.FLOW_ID, // ⚠️ Replace with Flow ID from Meta
                       // mode: "draft",
                       flow_cta: "Register Now",
                       flow_action: "navigate",
                       flow_action_payload: { screen: "DETAILS" }
                   }
               }
           }
       }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
   } catch (err) { console.error("Flow Send Error", err.response?.data); }
}


// FLOW 4: PAYMENT TEMPLATE
async function sendPaymentTemplate(to, name, amount) {
   try {
       await axios.post(META_URL, {
           messaging_product: "whatsapp", to: to, type: "template",
           template: {
               name: "payment_1", language: { code: "en" },
               components: [
                   { type: "body", parameters: [{ type: "text", text: name }, { type: "text", text: `₹${amount}` }] },
                   { type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: "btn_pay_now" }] },
                   { type: "button", sub_type: "quick_reply", index: 1, parameters: [{ type: "payload", payload: "btn_support" }] }
               ]
           }
       }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
   } catch (err) { console.error("Payment Tpl Error", err.response?.data); }
}


// FLOW 9: WEEKLY DELIVERY TEMPLATE
async function sendWeeklyDeliveryTemplate(to, name, time, otp) {
   try {
       await axios.post(META_URL, {
           messaging_product: "whatsapp", to: to, type: "template",
           template: {
               name: "weekly_delivery", language: { code: "en" },
               components: [
                   { type: "body", parameters: [{ type: "text", text: name }, { type: "text", text: time }, { type: "text", text: String(otp) }] },
                   { type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: "btn_pay_now_delivery" }] },
                   { type: "button", sub_type: "quick_reply", index: 1, parameters: [{ type: "payload", payload: "btn_pause_service" }] },
                   { type: "button", sub_type: "quick_reply", index: 2, parameters: [{ type: "payload", payload: "btn_reschedule_order" }] }
               ]
           }
       }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
   } catch (err) { console.error("Weekly Tpl Error", err.response?.data); }
}


// BUSINESS LOGIC: SAVE CUSTOMER (Flow 3)
// async function saveCustomerToDB(phone, data) {
//     let customer = await Customer.findOne({ primary_phone: phone });
  
//     // Note: Adjust 'data.name_field' etc. to match the key names in your Flow JSON
//     if (!customer) {
//         customer = new Customer({
//             primary_phone: phone,
//             head_of_family_name: data.name_field,
//             total_members: parseInt(data.members_count),
//             gc_id: data.selected_gc,
//             block: data.block_field,
//             flat: data.flat_field,
//             onboarding_step: "FLOW_3_SAVED"
//         });
//         await customer.save();
//         console.log(`✅ New Customer Saved: ${data.name_field}`);
//     }
//     return customer;
// }


// BUSINESS LOGIC: SUPPORT TICKET
async function createSupportTicket(phone, context) {
   const ticket = new SupportTicket({ customer_phone: phone, context_flow: context, status: "OPEN" });
   await ticket.save();
   await sendMessage(phone, "Your community executive from Kohinoor Elite Living will get in touch with you shortly.");
   console.log(`⚠️ Support Ticket Created for ${phone}`);
}


// BUSINESS LOGIC: RAZORPAY (Flow 5)
async function generateAndSendPaymentLink(phone) {
   const customer = await Customer.findOne({ primary_phone: phone });
   if (!customer) return;
  
   const pricePerMember = 1500;
   const amountInPaise = (customer.total_members * pricePerMember * 100);
  
   try {
       const link = await razorpay.paymentLink.create({
           amount: amountInPaise,
           currency: "INR",
           description: "Subscription Onboarding",
           customer: { name: customer.head_of_family_name, contact: phone },
           notify: { sms: true, email: false },
           callback_url: "https://wa.me/15551732703",
           callback_method: "get" ,


// 📝 CRITICAL UPDATE: PASS META-DATA IN NOTES
           notes: {
               customer_phone: phone,
               payment_type: "ONBOARDING" // <--- This tags the payment!
           }
       });
      // Send the link via WhatsApp
       await sendMessage(phone, `Registration Successful! 🎉\n\nTo finalize your onboarding for *${customer.total_members}* members, please complete the payment of INR ${amountInPaise / 100} here:\n${link.short_url}`);
   } catch (err) { console.error("RP Error", err); }
}

app.get("/", (req, res) => {
  res.send("Backend server is running successfully");
});
// ==============================================================
// 6. START SERVER
// ==============================================================
app.listen(PORT, () => {
   console.log(`🚀 Server running on port ${PORT}`);
   console.log(`⏰ Scheduler active (Runs every Monday at 9AM).`);
});


// ==============================================================
// 7. MANUAL TEST TRIGGERS (Call these from your Browser)
// ==============================================================


// TEST FLOW 1: Welcome Brochure (Triggers "Subscribe Now" button)
// Usage: http://localhost:3000/trigger/welcome?phone=919876543210
app.get('/trigger/welcome', async (req, res) => {
   const phone = req.query.phone;
   if (!phone) return res.status(400).send("❌ Error: Missing phone number. Use ?phone=91...");
  
   console.log(`🧪 TRIGGER: Sending Welcome Brochure to ${phone}`);
   await sendWelcomeBrochure(phone);
   res.send(`✅ Sent Welcome Brochure to ${phone}`);
});


// TEST FLOW 2: Registration Form (Opens the Flow)
// Usage: http://localhost:3000/trigger/register?phone=919876543210
app.get('/trigger/register', async (req, res) => {
   const phone = req.query.phone;
   if (!phone) return res.status(400).send("❌ Error: Missing phone number.");


   console.log(`🧪 TRIGGER: Sending Registration Flow to ${phone}`);
   await sendRegistrationFlow(phone);
   res.send(`✅ Sent Registration Flow to ${phone}`);
});


// TEST FLOW 4: Payment Template (The "Pay Now" button)
// Usage: http://localhost:3000/trigger/payment?phone=919876543210&amount=1500
app.get('/trigger/payment', async (req, res) => {
   const phone = req.query.phone;
   const amount = req.query.amount || "1500"; // Default to 1500 if not specified
   if (!phone) return res.status(400).send("❌ Error: Missing phone number.");


   console.log(`🧪 TRIGGER: Sending Payment Request of ₹${amount} to ${phone}`);
   await sendPaymentTemplate(phone, "Test User", amount);
   res.send(`✅ Sent Payment Template (₹${amount}) to ${phone}`);
});


// TEST FLOW 9: Weekly Delivery (The Monday Morning Update)
// Usage: http://localhost:3000/trigger/delivery?phone=919876543210
app.get('/trigger/delivery', async (req, res) => {
   const phone = req.query.phone;
   if (!phone) return res.status(400).send("❌ Error: Missing phone number.");


   // Mock OTP for testing
   const mockOtp = Math.floor(1000 + Math.random() * 9000);
  
   console.log(`🧪 TRIGGER: Sending Weekly Delivery Update to ${phone}`);
   await sendWeeklyDeliveryTemplate(phone, "Test User", "Morning Slot", mockOtp);
   res.send(`✅ Sent Weekly Delivery Update to ${phone} (OTP: ${mockOtp})`);
});

