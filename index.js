const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const crypto = require("crypto");
const { parseISO, startOfDay, endOfDay } = require("date-fns");

const serviceAccount = require("./serviceAccountKey.json");
const dotenv = require("dotenv").config();
const PORT = process.env.PORT;
const PROJECT_ID = process.env.PROJECT_ID;
console.log(process.env.SECRET_KEY);
// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: PROJECT_ID,
});

const app = express();

const db = admin.firestore();

// Middleware
app.use(cors());
app.use(express.json()); // Parse JSON bodies

// Route to submit a visit
// Route to submit a visit

// Function to generate 20-character encrypted data (QR code data)
const generateEncryptedData = (data) => {
  const cipher = crypto.createCipher("aes-256-cbc", process.env.SECRET_KEY); // Use AES encryption
  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted.slice(0, 20); // Get the first 20 characters
};

const parseRFIDTimestamp = (timestampStr) => {
  const [datePart, timePart] = timestampStr.split(" ");
  const [year, month, day] = datePart.split("-");
  const [hours, minutes, seconds] = timePart.split(":");
  return new Date(year, month - 1, day, hours, minutes, seconds);
};

// Function to fetch user details (firstName, lastName) by userId
const getUserDetails = async (userId) => {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      return {
        firstName: userData.firstName,
        lastName: userData.lastName,
        photoURL: userData.photoURL,
      };
    } else {
      return { firstName: "Unknown", lastName: "Unknown", photoURL: "Unknown" };
    }
  } catch (error) {
    console.error("Error fetching user details:", error);
    return { firstName: "Unknown", lastName: "Unknown", photoURL: "Unknown" };
  }
};

app.get("/data", async (req, res) => {
  try {
    const { startDate, endDate, type } = req.query;
    const start = startOfDay(parseISO(startDate));
    const end = endOfDay(parseISO(endDate));

    let dataCollection;
    if (type === "qrcode") {
      dataCollection = db.collection("scannedCodes");
    } else if (type === "rfid") {
      dataCollection = db.collection("rfid");
    } else {
      return res.status(400).json({ message: "Invalid type" });
    }

    const snapshot = await dataCollection.get();
    const data = [];

    for (const doc of snapshot.docs) {
      const docData = doc.data();
      let docTimestamp;

      if (type === "rfid") {
        docTimestamp = parseRFIDTimestamp(docData.timestamp); // Convert string timestamp to Date
      } else if (type === "qrcode") {
        docTimestamp = docData.scannedAt.toDate(); // Convert Firestore Timestamp to Date
      }

      if (docTimestamp >= start && docTimestamp <= end) {
        // Fetch user details based on userId
        const userDetails = await getUserDetails(docData.userId);

        data.push({
          id: doc.id,
          ...docData,
          firstName: userDetails.firstName,
          lastName: userDetails.lastName,
          photoURL: userDetails.photoURL,
        });
      }
    }
    console.log(data);

    res.json({ data });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ message: "Error fetching data", error });
  }
});

app.post("/approve-visit", async (req, res) => {
  const { visitRequestId } = req.body;

  if (!visitRequestId) {
    return res.status(400).send("Missing visit request ID.");
  }

  try {
    // Fetch the visit request from Firestore
    const visitRequestDoc = await admin
      .firestore()
      .collection("visitRequests")
      .doc(visitRequestId)
      .get();

    if (!visitRequestDoc.exists) {
      return res.status(404).send("Visit request not found.");
    }

    const visitData = visitRequestDoc.data();
    const visitorId = visitData.visitorId;

    // Calculate the expiration date (24 hours from visit time)
    const visitDateTime = new Date(
      `${visitData.visitDate} ${visitData.visitTime}`
    );
    const validFrom = visitDateTime; // Set the validFrom to the visit start time
    const validUntil = new Date(validFrom.getTime() + 24 * 60 * 60 * 1000); // Add 24 hours to validFrom

    // Generate encrypted QR code data
    const qrCodeData = generateEncryptedData(visitRequestId);

    // Store the encrypted QR code data in Firestore
    await admin.firestore().collection("userNotification").add({
      userId: visitData.visitorId,
      homeownerId: visitData.homeownerId,
      qrCode: qrCodeData,
      validFrom: validFrom,
      validUntil: validUntil,
      isRead: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update the homeownerNotification to 'approved'
    await admin
      .firestore()
      .collection("homeownerNotification")
      .doc(visitRequestId)
      .update({
        status: "approved",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Fetch the visitor's document from Firestore
    const visitorDoc = await admin
      .firestore()
      .collection("users")
      .doc(visitorId)
      .get();

    if (!visitorDoc.exists) {
      return res.status(404).send("Visitor not found.");
    }

    const visitorData = visitorDoc.data();
    const visitorToken = visitorData.fcmToken; // Get visitor's FCM token

    if (!visitorToken) {
      return res.status(400).send("Visitor does not have a valid FCM token.");
    }

    // Prepare the push notification data for the visitor
    const notificationData = {
      title: "Visit Approved",
      body: `Your visit request for ${visitData.visitDate} at ${visitData.visitTime} has been approved.`,
      data: {
        visitRequestId: visitRequestId,
        visitDate: visitData.visitDate,
        visitTime: visitData.visitTime,
        status: "approved",
      },
    };

    // Send the push notification to the visitor
    await sendNotification(visitorToken, notificationData);

    return res
      .status(200)
      .send("Visit approved, QR code generated, and notification sent.");
  } catch (error) {
    console.error("Error approving visit:", error);
    return res.status(500).send("Error approving visit.");
  }
});

app.post("/submit-visit", async (req, res) => {
  const { homeownerId, classification, visitDate, visitTime, visitorId } =
    req.body;

  // Check if all required fields are provided
  if (
    !homeownerId ||
    !classification ||
    !visitDate ||
    !visitTime ||
    !visitorId
  ) {
    return res.status(400).send("Missing required visit information.");
  }

  try {
    // Fetch the homeowner's document from Firestore
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(homeownerId)
      .get();

    if (!userDoc.exists) {
      return res.status(404).send("Homeowner not found.");
    }

    const userData = userDoc.data();
    const registrationToken = userData.fcmToken; // Ensure the user has an FCM token

    if (!registrationToken) {
      return res.status(400).send("Homeowner does not have a valid FCM token.");
    }

    // Prepare notification data
    const notificationData = {
      title: "New Visit Scheduled",
      body: `A visit has been scheduled for ${visitDate} at ${visitTime}. Classification: ${classification}`,
      data: {
        homeownerId: homeownerId,
        visitDate: visitDate,
        visitTime: visitTime,
        classification: classification,
      },
    };

    // Send the notification using Firebase Cloud Messaging
    await sendNotification(registrationToken, notificationData);

    // Create the visitRequest document in Firestore and capture the document ID
    const visitRequestRef = await admin
      .firestore()
      .collection("visitRequests")
      .add({
        homeownerId: homeownerId,
        visitorId: visitorId, // Store the ID of the visitor
        classification: classification,
        visitDate: visitDate,
        visitTime: visitTime,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    const visitRequestId = visitRequestRef.id; // Get the auto-generated ID

    // Use the same document ID for the homeownerNotification document
    await admin
      .firestore()
      .collection("homeownerNotification")
      .doc(visitRequestId)
      .set({
        isRead: 0, // Notification unread by default
        status: "pending", // Default status for notification
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Return a success response
    return res
      .status(201)
      .send("Visit submitted, notification sent, and visit request stored.");
  } catch (error) {
    console.error("Error submitting visit:", error);
    return res.status(500).send("Error submitting visit.");
  }
});

// Function to send push notifications using FCM v1 API
const sendNotification = async (registrationToken, notificationData) => {
  try {
    const message = {
      token: registrationToken,
      notification: {
        title: notificationData.title,
        body: notificationData.body,
      },
      data: notificationData.data,
    };

    const response = await admin.messaging().send(message);
    console.log("Notification sent successfully:", response);
  } catch (error) {
    console.error("Error sending notification:", error);
  }
};

// Endpoint to create a new user
app.post("/create-admin", async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    password,
    address,

    phoneNumber,
    rfid,
  } = req.body;
  console.log(req.body);
  if (
    !firstName ||
    !lastName ||
    !email ||
    !password ||
    !address ||
    !phoneNumber ||
    !rfid
  ) {
    return res
      .status(400)
      .json({ error: "Please provide all required fields." });
  }

  try {
    // Create the user with Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    // Add additional user data to Firestore
    await db.collection("users").doc(userRecord.uid).set({
      firstName,
      lastName,
      email,
      address,

      phoneNumber,
      rfid,
      role: "admin",
      photoURL: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res
      .status(201)
      .json({ message: "User created successfully", userId: userRecord.uid });
  } catch (error) {
    console.error("Error creating new user:", error);
    console.log(error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/create-homeowner", async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    password,
    address,

    phoneNumber,
    rfid,
  } = req.body;
  console.log(req.body);
  if (
    !firstName ||
    !lastName ||
    !email ||
    !password ||
    !address ||
    !phoneNumber ||
    !rfid
  ) {
    return res
      .status(400)
      .json({ error: "Please provide all required fields." });
  }

  try {
    // Create the user with Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    // Add additional user data to Firestore
    await db.collection("users").doc(userRecord.uid).set({
      firstName,
      lastName,
      email,
      address,

      phoneNumber,
      rfid,
      role: "homeowner",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res
      .status(201)
      .json({ message: "User created successfully", userId: userRecord.uid });
  } catch (error) {
    console.error("Error creating new user:", error);
    console.log(error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/create-security-personnel", async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    password,
    address,

    phoneNumber,
  } = req.body;
  console.log(req.body);
  if (
    !firstName ||
    !lastName ||
    !email ||
    !password ||
    !address ||
    !phoneNumber
  ) {
    return res
      .status(400)
      .json({ error: "Please provide all required fields." });
  }

  try {
    // Create the user with Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    // Add additional user data to Firestore
    await db.collection("users").doc(userRecord.uid).set({
      firstName,
      lastName,
      email,
      address,

      phoneNumber,
      role: "securityPersonnel",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res
      .status(201)
      .json({ message: "User created successfully", userId: userRecord.uid });
  } catch (error) {
    console.error("Error creating new user:", error);
    console.log(error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/create-user", async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    password,
    address,

    phoneNumber,
  } = req.body;
  console.log(req.body);
  if (
    !firstName ||
    !lastName ||
    !email ||
    !password ||
    !address ||
    !phoneNumber
  ) {
    return res
      .status(400)
      .json({ error: "Please provide all required fields." });
  }

  try {
    // Create the user with Firebase Authentication
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    // Add additional user data to Firestore
    await db.collection("users").doc(userRecord.uid).set({
      firstName,
      lastName,
      email,
      address,

      phoneNumber,
      role: "user",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res
      .status(201)
      .json({ message: "User created successfully", userId: userRecord.uid });
  } catch (error) {
    console.error("Error creating new user:", error);
    console.log(error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.delete("/delete-user/:uid", async (req, res) => {
  const { uid } = req.params;

  try {
    // Delete the user from Firebase Authentication
    await admin.auth().deleteUser(uid);
    console.log(`Successfully deleted user with UID: ${uid}`);

    // Delete the user document from Firestore
    await db.collection("users").doc(uid).delete();
    console.log(
      `Successfully deleted user data from Firestore for UID: ${uid}`
    );

    return res
      .status(200)
      .json({ message: `User with UID: ${uid} deleted successfully.` });
  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ error: "Error deleting user." });
  }
});

// Start the server

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
