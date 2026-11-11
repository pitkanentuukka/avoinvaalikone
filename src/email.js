const nodemailer = require("nodemailer");
const db = require("./db/pool");

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

// One pooled transport for the whole process. Bulk sends (a party's candidate
// links, question-set notifications to every candidate) fire many sendMail
// calls at once; the pool queues them over a few connections instead of
// opening one SMTP connection per message, which providers throttle or reject.
let transport = null;

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      pool: true,
      maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS || "3"),
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transport;
}

/**
 * Send one message and record the outcome in email_log. Rethrows a send
 * failure so callers that report back (re-sending a candidate's link) still
 * see it; a failure to write the log row is only logged.
 */
async function deliver(kind, message, { candidateId = null, partyId = null } = {}) {
  let sendErr = null;
  try {
    await getTransport().sendMail({
      from: process.env.SMTP_FROM || "noreply@vaalikone.fi",
      ...message,
    });
  } catch (err) {
    sendErr = err;
  }

  try {
    await db.query(
      `INSERT INTO email_log (kind, recipient, candidate_id, party_id, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        kind,
        message.to,
        candidateId,
        partyId,
        sendErr ? "failed" : "sent",
        sendErr ? String(sendErr.message || sendErr).slice(0, 500) : null,
      ]
    );
  } catch (logErr) {
    console.error("Sähköpostilokin kirjaus epäonnistui:", logErr);
  }

  if (sendErr) throw sendErr;
}

async function sendNewQuestionSetNotification(questionSet) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || !process.env.SMTP_HOST) return;

  const submittedAt = new Date(questionSet.submitted_at).toLocaleString("fi-FI");

  await deliver("admin_new_question_set", {
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

  await deliver("ngo_reviewed", {
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

async function sendQuestionSetPartialReviewNotification(questionSet, acceptedQuestions, modifiedQuestions, rejectedQuestions) {
  if (!questionSet.ngo_email || !process.env.SMTP_HOST) return;

  const allRejected = acceptedQuestions.length === 0 && modifiedQuestions.length === 0;

  const subject = allRejected
    ? sanitizeHeader(`Kysymyssarjanne on hylätty: ${questionSet.title}`)
    : sanitizeHeader(`Kysymyssarjanne on käsitelty: ${questionSet.title}`);

  const lines = [`Hei ${questionSet.ngo_name},`, ""];

  if (allRejected) {
    lines.push(`Kysymyssarjanne "${questionSet.title}" on valitettavasti hylätty kokonaan.`);
  } else {
    lines.push(`Kysymyssarjanne "${questionSet.title}" on käsitelty.`);

    if (acceptedQuestions.length > 0) {
      lines.push("");
      lines.push(`Hyväksytyt kysymykset (${acceptedQuestions.length}):`);
      acceptedQuestions.forEach((q, i) => {
        lines.push(`${i + 1}. "${q.statement}"`);
      });
    }

    if (modifiedQuestions.length > 0) {
      lines.push("");
      lines.push(`Muokatut kysymykset (${modifiedQuestions.length}):`);
      modifiedQuestions.forEach((q, i) => {
        lines.push(`${i + 1}. Alkuperäinen: "${q.originalStatement}"`);
        lines.push(`   Muokattu:     "${q.editedStatement}"`);
      });
    }
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
    lines.push("Ylläpito voi vielä muokata kysymyksiä ennen julkaisua. Saatte ilmoituksen, kun kysymyssarja on julkaistu.");
  } else {
    lines.push("");
    lines.push("Jos teillä on kysyttävää, ottakaa yhteyttä ylläpitoon.");
  }

  await deliver("ngo_partial_review", {
    to: questionSet.ngo_email,
    subject,
    text: lines.join("\n"),
  });
}

async function sendQuestionSetPublishedNotification(questionSet, questionCount) {
  if (!questionSet.ngo_email || !process.env.SMTP_HOST) return;

  await deliver("ngo_published", {
    to: questionSet.ngo_email,
    subject: sanitizeHeader(`Kysymyssarjanne on julkaistu: ${questionSet.title}`),
    text: [
      `Hei ${questionSet.ngo_name},`,
      "",
      `Kysymyssarjanne "${questionSet.title}" on nyt julkaistu Vaalikone 2026 -järjestelmässä.`,
      "",
      `Julkaistuja kysymyksiä: ${questionCount}`,
      "",
      "Kiitos osallistumisestanne!",
    ].join("\n"),
  });
}

async function sendApprovedQuestionSetNotificationToCandidate(questionSet, questionCount, candidate, frontendBaseUrl) {
  if (!process.env.SMTP_HOST) return;

  const answerLink = `${frontendBaseUrl}/?candidateToken=${candidate.token}`;

  await deliver("candidate_new_questions", {
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
  }, { candidateId: candidate.id });
}

async function sendApprovedQuestionSetNotificationToParty(questionSet, questionCount, party, frontendBaseUrl) {
  if (!process.env.SMTP_HOST) return;

  const portalLink = `${frontendBaseUrl}/?partyToken=${party.token}`;

  await deliver("party_new_questions", {
    to: party.email,
    subject: sanitizeHeader(`Uusi kysymyssarja hyväksytty: ${questionSet.title}`),
    text: [
      `Hei ${party.name},`,
      "",
      "Vaalikone 2026 -järjestelmään on hyväksytty uusi kysymyssarja.",
      "Ehdokkaanne saavat ilmoituksen ja oman vastauslinkkinsä sähköpostitse. Muistuttakaa heitä vastaamaan uusiin kysymyksiin.",
      "",
      `Järjestö: ${questionSet.ngo_name}`,
      `Kysymyssarja: ${questionSet.title}`,
      `Uusia kysymyksiä: ${questionCount}`,
      "",
      "Puolueportaali:",
      portalLink,
    ].join("\n"),
  }, { partyId: party.id });
}

/**
 * Send a candidate their personal answering link. Unlike the notifications
 * above, callers await this: when a party secretary asks to (re)send a link,
 * they need to know whether it actually went out.
 */
async function sendCandidateLinkEmail(candidate, partyName, frontendBaseUrl) {
  if (!process.env.SMTP_HOST) {
    throw new Error("SMTP is not configured");
  }

  const answerLink = `${frontendBaseUrl}/?candidateToken=${candidate.token}`;

  await deliver("candidate_link", {
    to: candidate.email,
    subject: "Henkilökohtainen vastauslinkkisi Vaalikone 2026 -järjestelmään",
    text: [
      `Hei ${candidate.name},`,
      "",
      `Olet ehdokkaana listalla: ${partyName}.`,
      "",
      "Tällä henkilökohtaisella linkillä voit muokata profiiliasi ja vastata kysymyksiin:",
      answerLink,
      "",
      "Säilytä linkki itselläsi äläkä jaa sitä: kuka tahansa linkin haltija voi muuttaa vastauksiasi.",
      "Jos linkki katoaa, puolueesi yhteyshenkilö voi lähettää sen uudelleen.",
    ].join("\n"),
  }, { candidateId: candidate.id });
}

module.exports = {
  sendCandidateLinkEmail,
  sendNewQuestionSetNotification,
  sendQuestionSetReviewedNotification,
  sendQuestionSetPartialReviewNotification,
  sendQuestionSetPublishedNotification,
  sendApprovedQuestionSetNotificationToCandidate,
  sendApprovedQuestionSetNotificationToParty,
};
