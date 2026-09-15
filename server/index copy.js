import fs from "node:fs";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { google } from "googleapis";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3001);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const CONTACT_EMAIL =
  process.env.CONTACT_EMAIL || process.env.SMTP_USER;

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : true;

/* ------------------------- Google configuration ------------------------- */

const GOOGLE_CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "./credentials/google-service-account.json";

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const GOOGLE_DRIVE_FOLDER_ID =
  process.env.GOOGLE_DRIVE_FOLDER_ID;

const SHEET_NAME =
  process.env.GOOGLE_SHEET_NAME || "Candidatures";

/* --------------------------- Paths -------------------------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dist = path.join(__dirname, "..", "dist");

/* --------------------------- Middleware --------------------------------- */

app.use(
  cors({
    origin: CORS_ORIGIN,
  })
);

app.use(
  express.json({
    limit: "60mb",
  })
);

/* --------------------------- Configuration ------------------------------ */

function checkConfig() {
  const required = [
    ["ADMIN_PASSWORD", ADMIN_PASSWORD],

    ["GOOGLE_CREDENTIALS_PATH", GOOGLE_CREDENTIALS_PATH],

    ["GOOGLE_SHEET_ID", GOOGLE_SHEET_ID],

    ["GOOGLE_DRIVE_FOLDER_ID", GOOGLE_DRIVE_FOLDER_ID],

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

/* ============================= GOOGLE ================================== */

let sheets = null;
let drive = null;

function initGoogle() {
  if (sheets && drive) {
    return;
  }

  if (!GOOGLE_CREDENTIALS_PATH) {
    throw new Error(
      "GOOGLE_CREDENTIALS_PATH est manquant."
    );
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
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },

    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });

  sheets = google.sheets({
    version: "v4",
    auth,
  });

  drive = google.drive({
    version: "v3",
    auth,
  });
}

/* --------------------------- Google Sheets ------------------------------ */

async function getSheetValues(range) {
  initGoogle();

  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
    });

  return response.data.values || [];
}

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

/* ============================= GMAIL =================================== */

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
      ) === "true",

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/* =========================== UTILITAIRES ================================ */

function escHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({
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
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 160);
}

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

/* ============================== TOKEN ================================== */

function makeToken() {
  const payload = Buffer.from(
    JSON.stringify({
      exp:
        Date.now() +
        8 * 60 * 60 * 1000,

      nonce:
        crypto.randomBytes(16).toString("hex"),
    })
  ).toString("base64url");

  const sig = crypto
    .createHmac(
      "sha256",
      ADMIN_PASSWORD || ""
    )
    .update(payload)
    .digest("base64url");

  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] =
      String(token || "").split(".");

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

    return (
      Number(data.exp) > Date.now()
    );
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

/* ============================ REFERENCES ================================ */

let referenceLock = Promise.resolve();

async function withReferenceLock(fn) {
  const previous = referenceLock;

  let release;

  referenceLock = new Promise(
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

async function nextReference() {
  const rows =
    await getSheetValues(
      `${SHEET_NAME}!A:A`
    );

  let max = 0;

  for (const row of rows) {
    const match = String(
      row[0] || ""
    ).match(
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

/* ============================ GOOGLE DRIVE ============================== */

async function createSubmissionFolder(
  ref
) {
  initGoogle();

  const response =
    await drive.files.create({
      supportsAllDrives: true,

      requestBody: {
        name: ref,

        mimeType:
          "application/vnd.google-apps.folder",

        parents: [
          GOOGLE_DRIVE_FOLDER_ID,
        ],
      },

      fields:
        "id,name,webViewLink",
    });

  return response.data;
}

async function uploadToDrive(
  folderId,
  file
) {
  initGoogle();

  const {
    mimeType,
    buffer,
  } = dataUrlToBuffer(
    file.data
  );

  const response =
    await drive.files.create({
      supportsAllDrives: true,

      requestBody: {
        name: safeName(
          file.name
        ),

        parents: [
          folderId,
        ],
      },

      media: {
        mimeType:
          file.type ||
          mimeType ||
          "application/octet-stream",

        body:
          Readable.from(buffer),
      },

      fields:
        "id,name,mimeType,size,webViewLink",
    });

  return {
    id: response.data.id,

    name:
      response.data.name,

    type:
      response.data.mimeType ||
      file.type ||
      mimeType,

    size: Number(
      response.data.size ||
        file.size ||
        buffer.length
    ),

    url:
      response.data.webViewLink ||
      `https://drive.google.com/file/d/${response.data.id}/view`,
  };
}

async function downloadFromDrive(
  fileId,
  res
) {
  initGoogle();

  const meta =
    await drive.files.get({
      fileId,

      fields:
        "id,name,mimeType,size",

      supportsAllDrives: true,
    });

  const file =
    await drive.files.get(
      {
        fileId,

        alt: "media",

        supportsAllDrives: true,
      },

      {
        responseType: "stream",
      }
    );

  res.setHeader(
    "Content-Type",
    meta.data.mimeType ||
      "application/octet-stream"
  );

  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(
      meta.data.name ||
        "document"
    )}`
  );

  file.data.on(
    "error",
    (error) => {
      console.error(
        "Drive download error:",
        error
      );

      if (!res.headersSent) {
        res.status(500).end();
      }
    }
  );

  file.data.pipe(res);
}

/* ============================ GOOGLE SHEETS ============================= */

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

    await sheets.spreadsheets.values.update(
      {
        spreadsheetId:
          GOOGLE_SHEET_ID,

        range:
          `${SHEET_NAME}!A1:T1`,

        valueInputOption: "RAW",

        requestBody: {
          values: [HEADERS],
        },
      }
    );
  }
}

function parseDocuments(value) {
  return String(value || "")
    .split(" || ")
    .filter(Boolean)
    .map((item) => {
      const [
        name,
        type,
        size,
        id,
      ] = item.split("@@");

      return {
        name:
          name || "document",

        type:
          type ||
          "application/octet-stream",

        size: Number(
          size || 0
        ),

        path: id || "",
      };
    })
    .filter(
      (file) => file.path
    );
}

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

/* =============================== EMAILS ================================= */

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

  const subject =
    `Gala Black Excellence Noire — candidature ${ref}`;

  const html = `
    <h2>Candidature reçue — ${escHtml(ref)}</h2>

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
      <strong>Documents :</strong>
      ${documents.length}
    </p>

    <p>
      Le dossier est enregistré dans
      Google Drive et les informations
      de candidature dans Google Sheets.
    </p>

    <p>
      <strong>Référence :</strong>
      ${escHtml(ref)}
    </p>
  `;

  await transport.sendMail({
    from:
      process.env.SMTP_FROM ||
      process.env.SMTP_USER,

    to: CONTACT_EMAIL,

    subject,

    html,
  });

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
          toute communication.
        </p>
      `,
    });
  }

  return {
    sent: true,
  };
}

/* ================================ API ================================== */

/* Health */

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
            "Google Drive",

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

/* Admin login */

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

/* Liste des candidatures */

app.get(
  "/api/admin/candidatures",
  requireAdmin,
  async (_req, res) => {
    try {
      res.json(
        await listCandidatures()
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

/* Téléchargement document */

app.get(
  "/api/admin/document",
  requireAdmin,
  async (req, res) => {
    try {
      const fileId = String(
        req.query.path || ""
      ).trim();

      if (
        !/^[A-Za-z0-9_-]{10,}$/.test(
          fileId
        )
      ) {
        return res
          .status(400)
          .end();
      }

      await downloadFromDrive(
        fileId,
        res
      );
    } catch (error) {
      console.error(
        "Téléchargement Drive impossible:",
        error
      );

      if (!res.headersSent) {
        res.status(404).end();
      }
    }
  }
);

/* Soumission candidature */

app.post(
  "/api/submit",
  async (req, res) => {
    try {
      const body =
        req.body || {};

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

      const result =
        await withReferenceLock(
          async () => {
            await ensureSheetHeader();

            const ref =
              await nextReference();

            const folder =
              await createSubmissionFolder(
                ref
              );

            const documents = [];

            for (
              const file of
                body.files || []
            ) {
              if (
                !file?.data
              ) {
                continue;
              }

              const uploaded =
                await uploadToDrive(
                  folder.id,
                  file
                );

              documents.push(
                uploaded
              );
            }

            const at =
              new Date().toISOString();

            const documentsCell =
              documents
                .map((file) =>
                  [
                    file.name,
                    file.type,
                    file.size,
                    file.id,
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

              folder,

              documents,
            };
          }
        );

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
            "La candidature est enregistrée, mais l'email a échoué.",
        };
      }

      res.json({
        ok: true,

        ref: result.ref,

        email,
      });
    } catch (error) {
      console.error(
        "Submission error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Impossible d'enregistrer la candidature",
      });
    }
  }
);

/* ======================= React production ============================== */

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

/* ============================== SERVER ================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Gala server listening on port ${PORT}`
    );

    console.log(
      "Stockage : Google Sheets + Google Drive"
    );

    console.log(
      "Emails : Gmail / SMTP"
    );
  }
);