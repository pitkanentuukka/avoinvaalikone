const nodemailer = require("nodemailer");
const Sentry = require("@sentry/node");
const db = require("./db/pool");

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

// One pooled transport for the whole process. Bulk sends (a party's candidate
// links, question-set notifications to every candidate) fire many sendMail
// calls at once; the pool queues them over a few connections instead of
// opening one SMTP connection per message, which providers throttle or reject.
let transport = null;

// Local mail catchers (the Compose mailpit service, or one on the host for a
// plain-Node run). They have no TLS.
const DEV_SMTP_HOSTS = ["localhost", "127.0.0.1", "::1", "mailpit"];
const isDevSmtpHost = (host) => DEV_SMTP_HOSTS.includes(String(host).toLowerCase());

function getTransport() {
  if (!transport) {
    const secure = process.env.SMTP_SECURE === "true";
    transport = nodemailer.createTransport({
      pool: true,
      maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS || "3"),
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure,
      // Without implicit TLS, nodemailer uses STARTTLS only if the server
      // offers it, so a server that doesn't (or an attacker stripping it)
      // would get the credentials and the magic links in plaintext (#192).
      // Decided by host, not NODE_ENV: Compose defaults NODE_ENV to
      // production for local dev with mailpit too, and a plain-Node
      // production may leave it unset. A dev host in production is warned
      // about by verifySmtp().
      requireTLS: !secure && !isDevSmtpHost(process.env.SMTP_HOST),
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transport;
}

const PLACEHOLDER_ADDRESS = /@example\.(com|org|net)>?\s*$/i;

/**
 * Settings that can't work in production but pass the prod compose file's
 * ":?" checks: the dev values in .env.example (which operators copy to .env)
 * and missing credentials. verify() logs in only when credentials are set, so
 * without them it passes against a provider that requires auth, and every
 * send then fails.
 */
function productionSmtpProblems() {
  const { SMTP_HOST, SMTP_PORT, SMTP_FROM, SMTP_USER } = process.env;
  const problems = [];
  if (isDevSmtpHost(SMTP_HOST)) {
    problems.push(`SMTP_HOST=${SMTP_HOST} on kehitysympäristön arvo: sähköpostit eivät lähde.`);
  }
  if (SMTP_PORT === "1025") {
    problems.push("SMTP_PORT=1025 on kehitysympäristön (mailpit) portti: palveluntarjoajat käyttävät porttia 587 tai 465.");
  }
  if (!SMTP_FROM) {
    problems.push("SMTP_FROM ei ole asetettu: lähettäjäksi tulee noreply@example.com, jonka vastaanottajat hylkäävät.");
  } else if (PLACEHOLDER_ADDRESS.test(SMTP_FROM)) {
    problems.push(`SMTP_FROM=${SMTP_FROM} on esimerkkiosoite, jonka vastaanottajat hylkäävät.`);
  }
  if (process.env.ADMIN_EMAIL && PLACEHOLDER_ADDRESS.test(process.env.ADMIN_EMAIL)) {
    problems.push(`ADMIN_EMAIL=${process.env.ADMIN_EMAIL} on esimerkkiosoite: ilmoitukset uusista kysymyssarjoista eivät tule perille.`);
  }
  if (!SMTP_USER) {
    problems.push("SMTP_USER ei ole asetettu: jos palveluntarjoaja vaatii kirjautumisen, sähköpostit epäonnistuvat.");
  }
  return problems;
}

/**
 * Check the SMTP connection once at startup and log the outcome. A wrong
 * SMTP_HOST or bad credentials otherwise surface only as failed rows in
 * email_log (#190). A failed check also goes to Sentry (a no-op without
 * SENTRY_DSN). Never throws: the API keeps serving either way.
 */
async function verifySmtp() {
  if (!process.env.SMTP_HOST) {
    console.warn("SMTP_HOST ei ole asetettu: sähköpostit (ehdokaslinkit, ilmoitukset) eivät lähde.");
    return;
  }
  if (process.env.NODE_ENV === "production") {
    for (const problem of productionSmtpProblems()) {
      console.warn(problem);
      Sentry.captureMessage(problem, "warning");
    }
  }
  const server = `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || "587"}`;
  try {
    await getTransport().verify();
    console.log(`SMTP-yhteys toimii: ${server}`);
  } catch (err) {
    const message = `SMTP-tarkistus epäonnistui (${server}), sähköpostit eivät lähde: ${err.message || err}`;
    console.error(message);
    Sentry.captureMessage(message, "error");
  }
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
      from: process.env.SMTP_FROM || "noreply@example.com",
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
  verifySmtp,
  sendCandidateLinkEmail,
  sendNewQuestionSetNotification,
  sendQuestionSetReviewedNotification,
  sendQuestionSetPartialReviewNotification,
  sendQuestionSetPublishedNotification,
  sendApprovedQuestionSetNotificationToCandidate,
  sendApprovedQuestionSetNotificationToParty,
};
