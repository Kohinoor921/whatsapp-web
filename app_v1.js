require('dotenv').config({ path: './keys.env' });
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
const Razorpay = require('razorpay');
const fs = require('fs');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');


// CUSTOM MODULES
const { connectDB, GC, Customer, Member, Plan, Order, SupportTicket, Counter, Payment, Document } = require('./db_schema');
const { decryptRequest, encryptResponse } = require('./crypto_utils');


const app = express();
app.use(bodyParser.json());


// ==============================================================
// 1. CONFIGURATION & SETUP
// ==============================================================
const PORT = process.env.PORT || 3000;
const CURRENT_ENV = process.env.APP_ENV || 'qa';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const META_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;


const razorpay = new Razorpay({
   key_id: process.env.RAZORPAY_KEY_ID,
   key_secret: process.env.RAZORPAY_KEY_SECRET
});


connectDB(CURRENT_ENV);


async function getNextSequence(name) {
   const ret = await Counter.findOneAndUpdate(
       { _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true }
   );
   return ret.seq;
}


// ==============================================================
// 2. WHATSAPP WEBHOOK (Flow 1, Support, Submissions)
// ==============================================================
app.get('/webhook', (req, res) => {
   const mode = req.query['hub.mode'];
   const token = req.query['hub.verify_token'];
   const challenge = req.query['hub.challenge'];
   if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
       res.status(200).send(challenge);
   } else {
       res.sendStatus(403);
   }
});


app.post('/webhook', async (req, res) => {
   const body = req.body;
   res.sendStatus(200); // Acknowledge Meta immediately


   if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
       const message = body.entry[0].changes[0].value.messages[0];
       const senderPhone = message.from;
      
       // FLOW 1: QR Code Scan (Exact Text Match)
       if (message.type === 'text') {
           const text = message.text.body.trim();
           if (text === "Hey! I want to know more about Kohinoor Elite Living’s end-to-end health subscriptions. How does it work?") {
               await sendWelcomeBrochure(senderPhone);
           }
       }


       // FLOW 2 & FLOW 9 & FLOW 15: Button Clicks
       if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
           const btnId = message.interactive.button_reply.id;


           if (btnId === 'btn_subscribe_now') await sendRegistrationFlow(senderPhone);
           if (btnId === 'btn_pay_now_delivery') await generateDeliveryPaymentLink(senderPhone); // Flow 9
           if (btnId === 'btn_pause_service') await sendMessage(senderPhone, "Our executive will call you shortly to pause/reschedule your order.");
           if (btnId === 'btn_support') await createSupportTicket(senderPhone, "User Requested Support");
           if (btnId === 'btn_view_diet') await sendMessage(senderPhone, "Welcome to Kohinoor, we are glad to have you here. PFA the document."); // Flow 15 extension
       }
   }
});


// ==============================================================
// 3. WA FLOW DATA ENDPOINT (Flow 2 & 3 & 4)
// ==============================================================
app.post('/flow-data', async (req, res) => {
   try {
       const privateKeyPem = fs.readFileSync(process.env.FLOW_PRIVATE_KEY, 'utf8');
       const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(req.body, privateKeyPem, process.env.FLOW_PASSPHRASE);
      
       const screen = decryptedBody.screen;
       const data = decryptedBody.data || {};
       const userAction = data.action_1 || data.action_2 || data.action_3 || "INIT";


       let responseData = {};


       if (!screen || screen === "HEALTH_CHECK") {
           responseData = { data: { status: "active" } };
       }
       else if (userAction === "INIT_SEARCH") {
           let initialCommunities = await GC.find({ is_active: true }).limit(10);
           responseData = {
               screen: "COMMUNITY_SEARCH",
               data: {
                   saved_name: data.name_1, saved_phone: data.phone_1, saved_members: data.members_count_1,
                   communities: initialCommunities.map(gc => ({ id: gc.gc_id.toString(), title: gc.name, description: gc.address }))
               }
           };
       }
       else if (userAction === "SEARCH_OR_NEXT") {
           const userSelection = data.selection_1;
           if (userSelection) {
               responseData = {
                   screen: "ADDRESS",
                   data: { final_name: data.prev_name, final_phone: data.prev_phone, final_members: data.prev_members, final_gc_id: userSelection }
               };
           } else {
               const searchQuery = data.query_1 || "";
               const communities = await GC.find({ name: { $regex: searchQuery, $options: 'i' } }).limit(10);
               responseData = {
                   screen: "COMMUNITY_SEARCH",
                   data: {
                       saved_name: data.prev_name, saved_phone: data.prev_phone, saved_members: data.prev_members,
                       communities: communities.map(gc => ({ id: gc.gc_id.toString(), title: gc.name, description: gc.address }))
                   }
               };
           }
       }
       else if (userAction === "SUBMIT_FORM") {
           let userPhone = data.final_phone.length === 10 ? "91" + data.final_phone : data.final_phone;
          
           const registrationData = {
               primary_phone: userPhone,
               head_of_family_name: data.final_name,
               total_members: parseInt(data.final_members || "1"),
               gc_id: data.final_gc_id,
               block: data.block,
               flat: data.flat,  
               onboarding_step: "REGISTERED" // FLOW 3
           };


           let customer = await Customer.findOne({ primary_phone: userPhone });


           if (customer) {
               Object.assign(customer, registrationData);
               await customer.save();
           } else {
               const nextId = await getNextSequence("customer_id");
               customer = new Customer({ customer_id: nextId, primary_phone: userPhone, ...registrationData });
               await customer.save();
           }


           // FLOW 3: Success Message (Delayed to allow UI to close)
           setTimeout(async () => {
               await sendMessage(userPhone, "You’re in! Thank you for choosing Kohinoor Elite Living. 💎\n\nYour journey to better health starts now. We have received your details and are setting up your personalized dashboard.");
              
               // FLOW 4: Discord Alert
               const discordMsg = `🚨 **NEW REGISTRATION**\n👤 **Name:** ${customer.head_of_family_name}\n📱 **Phone:** ${userPhone}\n👨‍👩‍👧 **Members:** ${customer.total_members}`;
               sendDiscordAlert(discordMsg, "ONBOARDING");
           }, 3000);


           responseData = { screen: "SUCCESS_SCREEN", data: {} };
       }


       const { encrypted_flow_data } = encryptResponse(responseData, aesKeyBuffer, initialVectorBuffer);
       res.send(encrypted_flow_data);


   } catch (error) {
       res.status(500).send();
   }
});


// ==============================================================
// 4. EXTERNAL APIs FOR EXECUTIVE WORKFLOW (Flow 5 to 15)
// ==============================================================


// FLOW 5: Add Family Members
app.post('/api/exec/members', async (req, res) => {
   try {
       const { primary_phone, members } = req.body; // members is an array of objects
      
       let customer = await Customer.findOne({ primary_phone });
       if (!customer) return res.status(404).json({ error: "Customer not found" });


       const savedMembers = [];
       for (let m of members) {
           const nextId = await getNextSequence("member_id");
           const newMember = new Member({
               member_id: `MEM_${nextId}`,
               customer_id: customer.primary_phone,
               name: m.name,
               age: m.age,
               sex: m.sex,
               plan_id: m.plan_id,
               needs_diagnostics: m.needs_diagnostics
           });
           await newMember.save();
           savedMembers.push(newMember);
       }


       res.json({ success: true, added_members: savedMembers.length });
   } catch (error) {
       res.status(500).json({ error: error.message });
   }
});


// FLOW 6: Generate Invoice and Razorpay Link
app.post('/api/exec/invoice', async (req, res) => {
   try {
       const { primary_phone, invoice_pdf_url } = req.body;
      
       const customer = await Customer.findOne({ primary_phone });
       if (!customer) return res.status(404).json({ error: "Customer not found" });


       const familyMembers = await Member.find({ customer_id: primary_phone });
      
       let totalCost = 0;
       for (let member of familyMembers) {
           const plan = await Plan.findOne({ plan_id: member.plan_id });
           if (plan) totalCost += plan.cost;
       }


       if (totalCost === 0) return res.status(400).json({ error: "Calculated cost is 0. Check plan mappings." });


       const link = await razorpay.paymentLink.create({
           amount: totalCost * 100,
           currency: "INR",
           description: "Kohinoor Elite Health Subscription",
           customer: { name: customer.head_of_family_name, contact: primary_phone },
           notes: { customer_phone: primary_phone, payment_type: "ONBOARDING" }
       });


       // Send WA Message with PDF and Link
       await sendInvoiceTemplate(primary_phone, invoice_pdf_url, totalCost, link.short_url);
      
       res.json({ success: true, payment_link: link.short_url, total_cost: totalCost });
   } catch (error) {
       res.status(500).json({ error: error.message });
   }
});


// FLOW 8: Trigger Diagnostics Schedule Confirmation
app.post('/api/exec/schedule-diagnostics', async (req, res) => {
   const { primary_phone, date, time } = req.body;
   await sendMessage(primary_phone, `Your diagnostics meeting with Thyrocare is scheduled for ${date} at ${time}. Sample collection will take place at your residence.`);
   res.json({ success: true });
});


// FLOW 14: Trigger Nutritionist Schedule
app.post('/api/exec/schedule-nutritionist', async (req, res) => {
   const { primary_phone, meet_link, timings } = req.body;
   // Assume an appointment_template exists in Meta
   await sendMessage(primary_phone, `Your meeting with the nutritionist is scheduled for ${timings}.\nJoin here: ${meet_link}`);
   res.json({ success: true });
});


// FLOW 15: Send Diet Plan PDF
app.post('/api/exec/send-diet-plan', async (req, res) => {
   const { primary_phone, pdf_url } = req.body;
  
   await axios.post(META_URL, {
       messaging_product: "whatsapp", to: primary_phone, type: "template",
       template: {
           name: "diet_plan", language: { code: "en" },
           components: [
               { type: "header", parameters: [{ type: "document", document: { link: pdf_url, filename: "Kohinoor_Diet_Plan.pdf" } }] },
               { type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: "btn_view_diet" }] },
               { type: "button", sub_type: "quick_reply", index: 1, parameters: [{ type: "payload", payload: "btn_support" }] }
           ]
       }
   }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });


   res.json({ success: true });
});


// ==============================================================
// 5. RAZORPAY WEBHOOK (Flow 7 & Flow 9 Updates)
// ==============================================================
app.post('/razorpay-webhook', async (req, res) => {
   res.json({ status: 'ok' });


   if (req.body.event === 'payment.captured') {
       try {
           const paymentEntity = req.body.payload.payment.entity;
           const customerPhone = paymentEntity.notes.customer_phone;
           const paymentType = paymentEntity.notes.payment_type || "ONBOARDING";


           const customer = await Customer.findOne({ primary_phone: customerPhone });


           if (customer) {
               const newPayment = new Payment({
                   customer_id: customer.customer_id, payment_type: paymentType,
                   razorpay_payment_id: paymentEntity.id, amount_paid: paymentEntity.amount / 100,
                   payment_status: "captured", payment_date: new Date()
               });
               await newPayment.save();


               if (paymentType === "ONBOARDING") {
                   customer.subscription_status = "ACTIVE";
                   customer.onboarding_step = "PAYMENT_COMPLETED";
                   await customer.save();


                   // FLOW 7: Payment Success Message + Video/Photo Link
                   await sendMessage(customerPhone, "ABCD\n\nHere is how to reach out for support: [Link to Support Video/Photo]");
               } else if (paymentType === "DELIVERY") {
                   // Update Order Status (Flow 9)
                   await Order.findOneAndUpdate(
                       { order_id: paymentEntity.notes.order_id },
                       { status: "paid" }
                   );
                   await sendMessage(customerPhone, "Your payment for the weekly delivery was successful!");
               }
           }
       } catch (err) {
           console.error("Webhook Logic Error:", err.message);
       }
   } else if (req.body.event === 'payment.failed') {
       const paymentEntity = req.body.payload.payment.entity;
       if (paymentEntity.notes.payment_type === "DELIVERY") {
           await sendMessage(paymentEntity.notes.customer_phone, "Your payment was unsuccessful. You can try to pay again or pay at home.");
       }
   }
});


// ==============================================================
// 6. HELPER FUNCTIONS
// ==============================================================


async function sendMessage(to, text) {
   await axios.post(META_URL, { messaging_product: "whatsapp", to: to, type: "text", text: { body: text } }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}


async function sendDiscordAlert(message, type = "GENERAL") {
   let webhookUrl = type === "ONBOARDING" ? process.env.DISCORD_WEBHOOK_ONBOARDING : process.env.DISCORD_WEBHOOK_GENERAL;
   if (webhookUrl) await axios.post(webhookUrl, { content: message });
}


// Flow 1 Flyer
async function sendWelcomeBrochure(to) {
   await axios.post(META_URL, {
       messaging_product: "whatsapp", to: to, type: "interactive",
       interactive: {
           type: "button",
           header: { type: "document", document: { link: "https://drive.google.com/uc?export=download&id=1dOoRtIkJcHbs_zbQ3QN1SO_fi4cS-M5V", filename: "Kohinoor_Elite_Plan.pdf" } },
           body: { text: "Here are all the details about our plan." },
           action: { buttons: [{ type: "reply", reply: { id: "btn_subscribe_now", title: "Subscribe Now" } }] }
       }
   }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}


// Flow 2 WA Form
async function sendRegistrationFlow(to) {
   await axios.post(META_URL, {
       messaging_product: "whatsapp", to: to, type: "interactive",
       interactive: {
           type: "flow", header: { type: "text", text: "Join Kohinoor Elite" },
           body: { text: "Please fill in your details." }, action: { name: "flow", parameters: { flow_message_version: "3", flow_token: "REG", flow_id: process.env.FLOW_ID, flow_cta: "Register Now", flow_action: "navigate", flow_action_payload: { screen: "DETAILS" } } }
       }
   }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}


// Flow 6 Invoice Message
async function sendInvoiceTemplate(to, pdfUrl, amount, paymentLink) {
   await axios.post(META_URL, {
       messaging_product: "whatsapp", to: to, type: "template",
       template: {
           name: "invoice_payment", language: { code: "en" },
           components: [
               { type: "header", parameters: [{ type: "document", document: { link: pdfUrl, filename: "Invoice.pdf" } }] },
               { type: "body", parameters: [{ type: "text", text: String(amount) }, { type: "text", text: paymentLink }] }
           ]
       }
   }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}


async function createSupportTicket(phone, context) {
   const ticket = new SupportTicket({ customer_phone: phone, context_flow: context, status: "OPEN" });
   await ticket.save();
   await sendMessage(phone, "Your community executive will get in touch with you shortly.");
}


app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


// ==============================================================
// MANUAL TEST TRIGGERS (Call from Browser)
// ==============================================================
app.get('/trigger/welcome', async (req, res) => {
   const phone = req.query.phone;
   if (!phone) return res.status(400).send("❌ Error: Missing phone number. Use ?phone=91...");
  
   console.log(`🧪 TRIGGER: Sending Welcome Brochure to ${phone}`);
   try {
       await sendWelcomeBrochure(phone);
       res.send(`✅ Sent Welcome Brochure to ${phone}`);
   } catch (error) {
 // If using Axios, the API's actual error message is usually inside error.response.data
 console.error("❌ Failed to send. Error details:", error.response?.data || error.message);
   }
});

