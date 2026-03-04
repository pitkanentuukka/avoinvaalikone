const nodemailer = require("nodemailer");

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendNewQuestionSetNotification(questionSet) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !process.env.SMTP_HOST) return;

  const transporter = createTransport();
  const submittedAt = new Date(questionSet.submitted_at).toLocaleString("fi-FI");

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
    to: adminEmail,
    subject: `Uusi kysymyssarja odottaa hyväksyntää: ${questionSet.title}`,
    text: [
      "Uusi kysymyssarja on lähetetty hyväksyttäväksi.",
      "",
      `Järjestö: ${questionSet.ngo_name}`,
      `Sähköposti: ${questionSet.ngo_email || "Ei annettu"}`,
      `Otsikko: ${questionSet.title}`,
      `Lähetetty: ${submittedAt}`,
    ].join("\n"),
  });
}

module.exports = { sendNewQuestionSetNotification };
