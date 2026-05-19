// sendMail.js
require("dotenv").config();
const nodemailer = require("nodemailer");

const MAILING_LIST =
  "andrew.watsonbd123@gmail.com, sanjida.amin.erin.2003@gmail.com, nusrat.cse.20230104065@aust.edu, abonty.cse.20230104052@aust.edu, shakhawat.cse.20230104081@aust.edu, taisha.cse.20230104013@aust.edu, mahim.cse.20230104015@aust.edu, oditto.cse.20230104014@aust.edu, ashraful.cse.20230104030@aust.edu, tamimshahadat15@gmail.com, arko.cse.20230104011@aust.edu";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendMail(course) {
  const code = course?.code || "Unknown";
  const title = course?.title || "";
  const subjectLine = "New Result published";
  const courseLabel = title ? `${code} - ${title}` : code;

  const message = {
    from: process.env.MAIL_FROM || process.env.EMAIL_USER,
    to: MAILING_LIST,
    subject: subjectLine,
    text: `Hello Friends,

The result for ${courseLabel} has been published on IUMS.

Please log in to IUMS to check your result.

Regards,
IUMS Result Notifier`,
  };

  try {
    const info = await transporter.sendMail(message);
    console.log("Email sent successfully:", info.messageId);
    return true;
  } catch (error) {
    console.error("Failed to send email:", error.message || error);
    return false;
  }
}

module.exports = { sendMail, MAILING_LIST };