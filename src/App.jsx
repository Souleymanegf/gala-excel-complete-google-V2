import fs from "node:fs";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();

/* =========================================================================
   CONFIGURATION GÉNÉRALE
   ========================================================================= */

const PORT = Number(process.env.PORT || 3001);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const CONTACT_EMAIL =
  process.env.CONTACT_EMAIL || process.env.SMTP_USER || "";

/*
 * Exemple :
 *
 * CORS_ORIGIN=http://localhost:5173,https://souleymeanegf.github.io
 *
 * Si CORS_ORIGIN n'est pas défini, on autorise toutes les origines.
 */

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : true;

/* =========================================================================
   GOOGLE SHEETS
   ========================================================================= */

const GOOGLE_CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/google-service-account.json";

const GOOGLE_SHEET_ID =
  process.env.GOOGLE_SHEET_ID || "";

const SHEET_NAME =
  process.env.GOOGLE_SHEET_NAME || "Candidatures";

/* =========================================================================
   CHEMINS
   ========================================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dist = path.join(__dirname, "..", "dist");

/* =========================================================================
   MIDDLEWARE
   ========================================================================= */

app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

app.use(
  express.json({
    /*
     * Les documents sont transmis en Base64.
     * 60 MB maximum pour une requête.
     */
    limit: "60mb",
  })
);

/* =========================================================================
   CONFIGURATION
   ========================================================================= */

function checkConfig() {
  const required = [
    ["ADMIN_PASSWORD", ADMIN_PASSWORD],
    [
      "GOOGLE_CREDENTIALS_PATH",
      GOOGLE_CREDENTIALS_PATH,
    ],
    ["GOOGLE_SHEET_ID", GOOGLE_SHEET_ID],
    ["SMTP_HOST", process.env.SMTP_HOST],
    ["SMTP_USER", process.env.SMTP_USER],
    ["SMTP_PASS", process.env.SMTP_PASS],
  ];

  const missing = required
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    console.warn(
      `Configuration manquante : ${missing.join(", ")}`
    );
  }
}

checkConfig();

/* =========================================================================
   GOOGLE AUTHENTICATION
   ========================================================================= */

let sheets = null;

function initGoogle() {
  if (sheets) {
    return;
  }

  const credentialsPath = path.resolve(
    process.cwd(),
    GOOGLE_CREDENTIALS_PATH
  );

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Fichier Google introuvable : ${credentialsPath}`
    );
  }

  let credentials;

  try {
    const raw = fs.readFileSync(
      credentialsPath,
      "utf8"
    );

    credentials = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Impossible de lire le fichier Google JSON : ${error.message}`
    );
  }

  if (
    credentials.type !== "service_account" ||
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error(
      "Le fichier JSON Google n'est pas un compte de service valide."
    );
  }

  console.log(
    `Google connecté avec le compte : ${credentials.client_email}`
  );

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email:
        credentials.client_email,

      private_key:
        credentials.private_key,
    },

    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });

  sheets = google.sheets({
    version: "v4",
    auth,
  });
}

/* =========================================================================
   GOOGLE SHEETS - LECTURE
   ========================================================================= */

async function getSheetValues(range) {
  initGoogle();

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
    });

  return response.data.values || [];
}

/* =========================================================================
   GOOGLE SHEETS - AJOUT
   ========================================================================= */

async function appendSheetRow(values) {
  initGoogle();

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,

    range: `${SHEET_NAME}!A:T`,

    valueInputOption: "USER_ENTERED",

    insertDataOption: "INSERT_ROWS",

    requestBody: {
      values: [values],
    },
  });
}

/* =========================================================================
   GMAIL / SMTP
   ========================================================================= */

function mailer() {
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,

    port: Number(
      process.env.SMTP_PORT || 587
    ),

    secure:
      String(
        process.env.SMTP_SECURE || "false"
      ).toLowerCase() === "true",

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/* =========================================================================
   UTILITAIRES
   ========================================================================= */

function escHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]
  );
}

function safeName(name) {
  return String(name || "document")
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 160);
}

/* =========================================================================
   BASE64 → BUFFER
   ========================================================================= */

function dataUrlToBuffer(dataUrl) {
  const match =
    /^data:([^;]+);base64,(.*)$/s.exec(
      dataUrl || ""
    );

  if (!match) {
    throw new Error(
      "Fichier encodé invalide."
    );
  }

  return {
    mimeType: match[1],

    buffer: Buffer.from(
      match[2],
      "base64"
    ),
  };
}

/* =========================================================================
   TOKEN ADMIN
   ========================================================================= */

function makeToken() {
  const payload = Buffer.from(
    JSON.stringify({
      exp:
        Date.now() +
        8 * 60 * 60 * 1000,

      nonce:
        crypto
          .randomBytes(16)
          .toString("hex"),
    })
  ).toString("base64url");

  const sig = crypto
    .createHmac(
      "sha256",
      ADMIN_PASSWORD
    )
    .update(payload)
    .digest("base64url");

  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [
      payload,
      sig,
    ] = String(token || "").split(".");

    if (
      !payload ||
      !sig ||
      !ADMIN_PASSWORD
    ) {
      return false;
    }

    const expected = crypto
      .createHmac(
        "sha256",
        ADMIN_PASSWORD
      )
      .update(payload)
      .digest("base64url");

    const a = Buffer.from(sig);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return false;
    }

    const data = JSON.parse(
      Buffer.from(
        payload,
        "base64url"
      ).toString("utf8")
    );

    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(
  req,
  res,
  next
) {
  const token = String(
    req.headers.authorization || ""
  ).replace(
    /^Bearer\s+/i,
    ""
  );

  if (!verifyToken(token)) {
    return res.status(401).json({
      error: "Non autorisé",
    });
  }

  next();
}

/* =========================================================================
   VERROU POUR LES RÉFÉRENCES
   ========================================================================= */

let referenceLock =
  Promise.resolve();

async function withReferenceLock(
  fn
) {
  const previous =
    referenceLock;

  let release;

  referenceLock =
    new Promise(
      (resolve) => {
        release = resolve;
      }
    );

  await previous;

  try {
    return await fn();
  } finally {
    release();
  }
}

/* =========================================================================
   PROCHAINE RÉFÉRENCE
   ========================================================================= */

async function nextReference() {
  const rows =
    await getSheetValues(
      `${SHEET_NAME}!A:A`
    );

  let max = 0;

  for (const row of rows) {
    const match =
      String(row[0] || "").match(
        /^GBE2027-(\d{6})$/
      );

    if (match) {
      max = Math.max(
        max,
        Number(match[1])
      );
    }
  }

  return `GBE2027-${String(
    max + 1
  ).padStart(6, "0")}`;
}

/* =========================================================================
   EN-TÊTES GOOGLE SHEETS
   ========================================================================= */

const HEADERS = [
  "Référence",
  "Date",
  "Langue",
  "Prix",
  "Nom",
  "Organisation",
  "Ville",
  "Courriel",
  "Téléphone",
  "Lien",
  "Âge",
  "Déposé par",
  "Nom proposant",
  "Courriel proposant",
  "Parcours",
  "Racines",
  "Audace",
  "Liens supplémentaires",
  "Références",
  "Documents",
];

async function ensureSheetHeader() {
  const rows =
    await getSheetValues(
      `${SHEET_NAME}!A1:T1`
    );

  if (
    !rows.length ||
    !rows[0].some(
      (value) =>
        String(value || "").trim()
    )
  ) {
    initGoogle();

    await sheets.spreadsheets.values.update({
      spreadsheetId:
        GOOGLE_SHEET_ID,

      range:
        `${SHEET_NAME}!A1:T1`,

      valueInputOption: "RAW",

      requestBody: {
        values: [HEADERS],
      },
    });
  }
}

/* =========================================================================
   DOCUMENTS - LECTURE DEPUIS GOOGLE SHEETS
   ========================================================================= */

function parseDocuments(value) {
  return String(value || "")
    .split(" || ")
    .filter(Boolean)
    .map((item) => {
      const [
        name,
        type,
        size,
      ] = item.split("@@");

      return {
        name:
          name || "document",

        type:
          type ||
          "application/octet-stream",

        size:
          Number(size || 0),

        /*
         * Il n'y a plus de chemin Google Drive.
         */
        path: "",
      };
    });
}

/* =========================================================================
   LISTE DES CANDIDATURES
   ========================================================================= */

async function listCandidatures() {
  await ensureSheetHeader();

  const rows =
    await getSheetValues(
      `${SHEET_NAME}!A:T`
    );

  if (rows.length <= 1) {
    return [];
  }

  return rows
    .slice(1)
    .filter(
      (row) => row[0]
    )
    .map((row) => ({
      ref: row[0] || "",

      at: row[1] || "",

      lang: row[2] || "",

      prize: row[3] || "",

      name: row[4] || "",

      org: row[5] || "",

      city: row[6] || "",

      email: row[7] || "",

      tel: row[8] || "",

      link: row[9] || "",

      age: row[10] || "",

      self:
        row[11] ===
        "soi-meme",

      propName:
        row[12] || "",

      propEmail:
        row[13] || "",

      path:
        row[14] || "",

      root:
        row[15] || "",

      bold:
        row[16] || "",

      links:
        row[17] || "",

      refs:
        row[18] || "",

      files:
        parseDocuments(
          row[19]
        ),
    }))
    .sort(
      (a, b) =>
        String(a.at) <
        String(b.at)
          ? 1
          : -1
    );
}

/* =========================================================================
   ENVOI DES COURRIELS
   ========================================================================= */

async function sendSubmissionEmails(
  body,
  ref,
  documents
) {
  const transport = mailer();

  if (!transport) {
    return {
      sent: false,

      reason:
        "SMTP non configuré",
    };
  }

  const attachments = [];

  /*
   * Les documents sont uniquement conservés
   * en mémoire pendant l'envoi du courriel.
   *
   * Ils ne sont PAS envoyés vers Google Drive.
   */

  for (const file of documents) {
    if (!file?.data) {
      continue;
    }

    const {
      mimeType,
      buffer,
    } = dataUrlToBuffer(
      file.data
    );

    attachments.push({
      filename: safeName(
        file.name
      ),

      content: buffer,

      contentType:
        file.type ||
        mimeType ||
        "application/octet-stream",
    });
  }

  const subject =
    `Gala Black Excellence Noire — candidature ${ref}`;

  const html = `
    <h2>
      Candidature reçue — ${escHtml(ref)}
    </h2>

    <p>
      <strong>Nom :</strong>
      ${escHtml(body.name)}
    </p>

    <p>
      <strong>Prix :</strong>
      ${escHtml(body.prize)}
    </p>

    <p>
      <strong>Organisation :</strong>
      ${escHtml(body.org)}
    </p>

    <p>
      <strong>Ville :</strong>
      ${escHtml(body.city)}
    </p>

    <p>
      <strong>Courriel :</strong>
      ${escHtml(body.email)}
    </p>

    <p>
      <strong>Téléphone :</strong>
      ${escHtml(body.tel)}
    </p>

    <p>
      <strong>Documents joints :</strong>
      ${attachments.length}
    </p>

    <p>
      Les informations de la candidature
      sont enregistrées dans Google Sheets.
    </p>

    <p>
      Les documents sont transmis directement
      en pièces jointes à ce courriel.
    </p>

    <p>
      <strong>Référence :</strong>
      ${escHtml(ref)}
    </p>
  `;

  /*
   * COURRIEL ADMINISTRATION
   */

  if (!CONTACT_EMAIL) {
    throw new Error(
      "CONTACT_EMAIL n'est pas configuré."
    );
  }

  await transport.sendMail({
    from:
      process.env.SMTP_FROM ||
      process.env.SMTP_USER,

    to: CONTACT_EMAIL,

    subject,

    html,

    attachments,
  });

  /*
   * COURRIEL CANDIDAT
   */

  if (body.email) {
    await transport.sendMail({
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER,

      to: body.email,

      subject:
        `Votre candidature ${ref} — Gala Black Excellence Noire`,

      html: `
        <p>
          Bonjour,
        </p>

        <p>
          Nous confirmons la réception
          de votre candidature.
        </p>

        <p>
          <strong>
            Numéro de référence :
            ${escHtml(ref)}
          </strong>
        </p>

        <p>
          Conservez ce numéro pour
          toute communication concernant
          votre candidature.
        </p>

        <p>
          Merci pour votre participation.
        </p>
      `,
    });
  }

  return {
    sent: true,

    attachments:
      attachments.length,
  };
}

/* =========================================================================
   API HEALTH
   ========================================================================= */

app.get(
  "/api/health",
  async (_req, res) => {
    try {
      await ensureSheetHeader();

      res.json({
        ok: true,

        storage: {
          database:
            "Google Sheets",

          documents:
            "Email uniquement",

          email:
            "Gmail / SMTP",
        },
      });
    } catch (error) {
      console.error(
        "Health error:",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Configuration Google non valide",
      });
    }
  }
);

/* =========================================================================
   API ADMIN LOGIN
   ========================================================================= */

app.post(
  "/api/admin/login",
  (req, res) => {
    if (
      !ADMIN_PASSWORD ||
      req.body?.password !==
        ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .json({
          error:
            "Code incorrect",
        });
    }

    res.json({
      token: makeToken(),
    });
  }
);

/* =========================================================================
   API ADMIN - CANDIDATURES
   ========================================================================= */

app.get(
  "/api/admin/candidatures",
  requireAdmin,
  async (_req, res) => {
    try {
      const candidatures =
        await listCandidatures();

      res.json(
        candidatures
      );
    } catch (error) {
      console.error(
        "Lecture Google Sheets impossible:",
        error
      );

      res.status(500).json({
        error:
          "Lecture Google Sheets impossible",
      });
    }
  }
);

/* =========================================================================
   API - SOUMISSION
   ========================================================================= */

app.post(
  "/api/submit",
  async (req, res) => {
    try {
      const body =
        req.body || {};

      /*
       * Vérification minimale
       */

      if (
        !body.name ||
        !body.prize
      ) {
        return res
          .status(400)
          .json({
            error:
              "Données de candidature incomplètes",
          });
      }

      /*
       * Protection contre les références identiques
       */

      const result =
        await withReferenceLock(
          async () => {
            await ensureSheetHeader();

            const ref =
              await nextReference();

            const documents = [];

            /*
             * Préparation des documents
             */

            for (
              const file of
                body.files || []
            ) {
              if (!file?.data) {
                continue;
              }

              const {
                mimeType,
                buffer,
              } = dataUrlToBuffer(
                file.data
              );

              documents.push({
                name:
                  safeName(
                    file.name
                  ),

                type:
                  file.type ||
                  mimeType ||
                  "application/octet-stream",

                size:
                  Number(
                    file.size ||
                      buffer.length
                  ),

                data:
                  file.data,
              });
            }

            /*
             * Date de soumission
             */

            const at =
              new Date().toISOString();

            /*
             * Documents enregistrés
             * dans Google Sheets uniquement
             * sous forme de métadonnées.
             */

            const documentsCell =
              documents
                .map((file) =>
                  [
                    file.name,
                    file.type,
                    file.size,
                  ]
                    .map((value) =>
                      String(
                        value
                      ).replaceAll(
                        "@@",
                        "_"
                      )
                    )
                    .join("@@")
                )
                .join(" || ");

            /*
             * Enregistrement dans Google Sheets
             */

            await appendSheetRow([
              ref,

              at,

              body.lang ||
                "fr",

              body.prize ||
                "",

              body.name ||
                "",

              body.org ||
                "",

              body.city ||
                "",

              body.email ||
                "",

              body.tel ||
                "",

              body.link
                ? `${body.link}${
                    body.linkP
                      ? ` - ${body.linkP}`
                      : ""
                  }`
                : "",

              body.age ||
                "",

              body.self
                ? "soi-meme"
                : "proposant",

              body.propName ||
                "",

              body.propEmail ||
                "",

              body.path ||
                "",

              body.root ||
                "",

              body.bold ||
                "",

              body.links ||
                "",

              body.refs ||
                "",

              documentsCell,
            ]);

            return {
              ref,

              documents,
            };
          }
        );

      /*
       * Envoi des courriels
       */

      let email = {
        sent: false,
      };

      try {
        email =
          await sendSubmissionEmails(
            body,
            result.ref,
            result.documents
          );
      } catch (mailError) {
        console.error(
          "Email error:",
          mailError
        );

        email = {
          sent: false,

          reason:
            "La candidature est enregistrée dans Google Sheets, mais l'email a échoué.",
        };
      }

      /*
       * Réponse finale au frontend
       */

      return res.json({
        ok: true,

        ref: result.ref,

        email,
      });
    } catch (error) {
      console.error(
        "Submission error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Impossible d'enregistrer la candidature",
      });
    }
  }
);

/* =========================================================================
   REACT - PRODUCTION
   =========================================================================
   
   Cette partie est utile si le backend et le frontend sont hébergés
   ensemble sur le même serveur.

   Si React est uniquement sur GitHub Pages, GitHub Pages servira
   le frontend et cette partie n'est pas utilisée.
   ========================================================================= */

if (
  process.env.NODE_ENV ===
  "production"
) {
  app.use(
    express.static(dist)
  );

  app.get(
    "*",
    (_req, res) => {
      res.sendFile(
        path.join(
          dist,
          "index.html"
        )
      );
    }
  );
}

/* =========================================================================
   SERVEUR
   ========================================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Gala server listening on port ${PORT}`
    );

    console.log(
      `Port : ${PORT}`
    );

    console.log(
      `Google Sheet : ${GOOGLE_SHEET_ID}`
    );

    console.log(
      `Onglet : ${SHEET_NAME}`
    );

    console.log(
      "Stockage : Google Sheets"
    );

    console.log(
      "Documents : pièces jointes email"
    );

    console.log(
      "Emails : Gmail / SMTP"
    );

    console.log(
      `CORS : ${
        Array.isArray(CORS_ORIGIN)
          ? CORS_ORIGIN.join(", ")
          : "toutes les origines"
      }`
    );
  }
);