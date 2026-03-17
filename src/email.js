const nodemailer = require("nodemailer");

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

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
    subject: sanitizeHeader(`Uusi kysymyssarja odottaa hyväksyntää: ${questionSet.title}`),
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

async function sendQuestionSetReviewedNotification(questionSet, approved) {
  if (!questionSet.ngo_email || !process.env.SMTP_HOST) return;

  const transporter = createTransport();

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
    to: questionSet.ngo_email,
    subject: approved
      ? sanitizeHeader(`Kysymyssarjanne on hyväksytty: ${questionSet.title}`)
      : sanitizeHeader(`Kysymyssarjanne on hylätty: ${questionSet.title}`),
    text: approved
      ? [
          `Hei ${questionSet.ngo_name},`,
          "",
          `Kysymyssarjanne "${questionSet.title}" on hyväksytty ja se on nyt näkyvissä Vaalikone 2026 -järjestelmässä.`,
          "",
          "Kiitos osallistumisestanne!",
        ].join("\n")
      : [
          `Hei ${questionSet.ngo_name},`,
          "",
          `Kysymyssarjanne "${questionSet.title}" on valitettavasti hylätty.`,
          "",
          "Jos teillä on kysyttävää, ottakaa yhteyttä ylläpitoon.",
        ].join("\n"),
  });
}

async function sendQuestionSetPartialReviewNotification(questionSet, acceptedCount, rejectedQuestions) {
  if (!questionSet.ngo_email || !process.env.SMTP_HOST) return;

  const transporter = createTransport();
  const allRejected = acceptedCount === 0;

  const subject = allRejected
    ? sanitizeHeader(`Kysymyssarjanne on hylätty: ${questionSet.title}`)
    : sanitizeHeader(`Kysymyssarjanne on käsitelty: ${questionSet.title}`);

  const lines = [`Hei ${questionSet.ngo_name},`, ""];

  if (allRejected) {
    lines.push(`Kysymyssarjanne "${questionSet.title}" on valitettavasti hylätty kokonaan.`);
  } else {
    lines.push(`Kysymyssarjanne "${questionSet.title}" on käsitelty.`);
    lines.push("");
    lines.push(`Hyväksyttyjä kysymyksiä: ${acceptedCount}`);
  }

  if (rejectedQuestions.length > 0) {
    lines.push("");
    lines.push(`Hylätyt kysymykset (${rejectedQuestions.length}):`);
    rejectedQuestions.forEach((q, i) => {
      lines.push(`${i + 1}. "${q.statement}"`);
      if (q.rejectionReason) {
        lines.push(`   Syy: ${q.rejectionReason}`);
      }
    });
  }

  if (!allRejected) {
    lines.push("");
    lines.push("Hyväksytyt kysymykset ovat nyt näkyvissä Vaalikone 2026 -järjestelmässä.");
    lines.push("");
    lines.push("Kiitos osallistumisestanne!");
  } else {
    lines.push("");
    lines.push("Jos teillä on kysyttävää, ottakaa yhteyttä ylläpitoon.");
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
    to: questionSet.ngo_email,
    subject,
    text: lines.join("\n"),
  });
}

async function sendApprovedQuestionSetNotificationToCandidate(questionSet, questionCount, candidate, frontendBaseUrl) {
  if (!process.env.SMTP_HOST) return;

  const transporter = createTransport();
  const answerLink = `${frontendBaseUrl}/?view=candidate&partyToken=${candidate.party_token}&candidateId=${candidate.id}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
    to: candidate.email,
    subject: sanitizeHeader(`Uusia kysymyksiä vastaustasi odottamassa: ${questionSet.title}`),
    text: [
      `Hei ${candidate.name},`,
      "",
      "Vaalikone 2026 -järjestelmään on hyväksytty uusi kysymyssarja, johon sinua pyydetään vastaamaan.",
      "",
      `Järjestö: ${questionSet.ngo_name}`,
      `Kysymyssarja: ${questionSet.title}`,
      `Uusia kysymyksiä: ${questionCount}`,
      "",
      "Voit vastata kysymyksiin täältä:",
      answerLink,
    ].join("\n"),
  });
}

async function sendApprovedQuestionSetNotificationToParty(questionSet, questionCount, party, frontendBaseUrl) {
  if (!process.env.SMTP_HOST) return;

  const transporter = createTransport();
  const portalLink = `${frontendBaseUrl}/?view=candidate&partyToken=${party.token}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
    to: party.email,
    subject: sanitizeHeader(`Uusi kysymyssarja hyväksytty: ${questionSet.title}`),
    text: [
      `Hei ${party.name},`,
      "",
      "Vaalikone 2026 -järjestelmään on hyväksytty uusi kysymyssarja.",
      "Muistuttakaa ehdokkaitanne kirjautumaan puoluepuolueellenne ja vastaamaan uusiin kysymyksiin.",
      "",
      `Järjestö: ${questionSet.ngo_name}`,
      `Kysymyssarja: ${questionSet.title}`,
      `Uusia kysymyksiä: ${questionCount}`,
      "",
      "Puolueportaali:",
      portalLink,
    ].join("\n"),
  });
}

module.exports = {
  sendNewQuestionSetNotification,
  sendQuestionSetReviewedNotification,
  sendQuestionSetPartialReviewNotification,
  sendApprovedQuestionSetNotificationToCandidate,
  sendApprovedQuestionSetNotificationToParty,
};
