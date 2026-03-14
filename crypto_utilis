const crypto = require('crypto');


// ALGORITHM SETTINGS
// Meta uses AES-128-GCM for encryption
const ALGORITHM = 'aes-128-gcm';
const TAG_LENGTH = 16;


// =========================================================================
// 1. DECRYPT REQUEST (From Meta -> Your Server)
// =========================================================================
function decryptRequest(body, privateKeyPem, passphrase) {
   const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;


   // A. Decrypt the AES Key using your Private Key
   // We use the passphrase here if your key has one
   const privateKey = {
       key: privateKeyPem,
       passphrase: passphrase,
       padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
       oaepHash: "sha256",
   };


   const decryptedAesKey = crypto.privateDecrypt(
       privateKey,
       Buffer.from(encrypted_aes_key, 'base64')
   );


   // B. Decrypt the Flow Data using the AES Key
   const ivBuffer = Buffer.from(initial_vector, 'base64');
   const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');


   // Split data into content and auth tag (last 16 bytes)
   const authTag = flowDataBuffer.subarray(flowDataBuffer.length - TAG_LENGTH);
   const encryptedData = flowDataBuffer.subarray(0, flowDataBuffer.length - TAG_LENGTH);


   const decipher = crypto.createDecipheriv(ALGORITHM, decryptedAesKey, ivBuffer);
   decipher.setAuthTag(authTag);


   let decrypted = decipher.update(encryptedData, null, 'utf8');
   decrypted += decipher.final('utf8');


   return {
       decryptedBody: JSON.parse(decrypted),
       aesKeyBuffer: decryptedAesKey,
       initialVectorBuffer: ivBuffer
   };
}


// =========================================================================
// 2. ENCRYPT RESPONSE (Your Server -> Meta)
// =========================================================================
function encryptResponse(responseJson, aesKeyBuffer, initialVectorBuffer) {
  
   // A. Flip the bits of the Initial Vector (Standard Meta Requirement)
   const flippedIv = Buffer.from(initialVectorBuffer);
   for (let i = 0; i < flippedIv.length; i++) {
       flippedIv[i] = ~flippedIv[i];
   }


   // B. Encrypt the Response Data
   const cipher = crypto.createCipheriv(ALGORITHM, aesKeyBuffer, flippedIv);
   let encrypted = cipher.update(JSON.stringify(responseJson), 'utf8', 'base64');
   encrypted += cipher.final('base64');
   const authTag = cipher.getAuthTag().toString('base64');


   // C. Combine Encrypted Data + Auth Tag
   return {
       encrypted_flow_data: Buffer.concat([
           Buffer.from(encrypted, 'base64'),
           Buffer.from(authTag, 'base64')
       ]).toString('base64')
   };
}


module.exports = { decryptRequest, encryptResponse };

