const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const paydunya = require("paydunya");
const Stripe = require("stripe");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
const PAYDUNYA_ENABLED =
  process.env.PAYDUNYA_ENABLED === "true";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.disable("x-powered-by");

const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const SITE_ORIGIN = SITE_URL ? new URL(SITE_URL).origin : "";

if (
  !SITE_URL ||
  !process.env.ADMIN_PASSWORD_HASH
) {
  throw new Error(
    "Configurer SITE_URL et ADMIN_PASSWORD_HASH"
  );
}

if (
  process.env.STRIPE_PAYMENTS_ENABLED === "true" &&
  !process.env.STRIPE_SECRET_KEY
) {
  throw new Error(
    "Configurer STRIPE_SECRET_KEY pour activer Stripe"
  );
}
app.use(cors({
  origin(origin, callback) {

    const allowedOrigins = [
      SITE_ORIGIN,
      "http://127.0.0.1:5500",
      "http://localhost:5500"
    ];

    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error("Origine non autorisée"));
  }
}));

// Stripe exige le corps brut pour verifier la signature du webhook.
// Cette route doit etre declaree AVANT express.json().
app.post("/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (process.env.STRIPE_PAYMENTS_ENABLED !== "true" &&
      process.env.STRIPE_TEST_MODE !== "true") {
    return res.status(503).send("Stripe temporairement desactive");
  }
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Webhook Stripe non configure");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.get("stripe-signature"),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).send("Signature Stripe invalide");
  }

  if (event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded") {
    return res.json({ received: true });
  }

  try {
    const session = event.data.object;
if (
  session.payment_status !== "paid" ||
  session.mode !== "payment"
) {
  return res.json({ received: true });
}
    const orderId = Number(session.metadata?.order_id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return res.status(400).send("Commande Stripe invalide");
    }
    const confirm = db.transaction(() => {
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
      if (order && order.payment_provider !== "stripe") {
        throw new Error("Fournisseur de paiement Stripe incorrect");
      }
      // La notification peut arriver avant l'enregistrement de la session Stripe.
      // Ne jamais confirmer une commande sans son identifiant de session verifie.
      // Stripe reessaiera la notification apres une reponse temporaire 503.
      if (order && order.status === "pending" && order.invoice_token === null) {
        const retryError = new Error("Session Stripe pas encore enregistree");
        retryError.code = "STRIPE_SESSION_PENDING";
        throw retryError;
      }
      if (!order || typeof order.invoice_token !== "string" ||
          order.invoice_token !== session.id ||
          !order.invoice_token.startsWith("cs_")) {
        throw new Error("Session Stripe sans commande correspondante");
      }
      const articles = db.prepare(
        "SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ?"
      ).all(orderId);
      if (!articles.length) throw new Error("Commande sans articles");
      // Récupérer le pays enregistré lors de la commande
let customer;

try {
  customer = JSON.parse(order.customer);
} catch (error) {
  throw new Error("Informations client invalides");
}

// Déterminer la devise attendue selon le pays
const expectedCurrency = getStripeCurrencyByCountry(customer?.country);

if (!expectedCurrency) {
  throw new Error("Pays de commande non pris en charge");
}

// Recalculer le montant à partir des articles enregistrés
const totalXof = articles.reduce(
  (sum, a) => sum + a.quantity * a.unit_price,
  0
);

// EUR : centimes / XOF et XAF : unités entières
const expectedAmount =
  expectedCurrency === "eur"
    ? Math.round(totalXof * 100 / 655.957)
    : totalXof;

const minimumAmount =
  expectedCurrency === "eur" ? 50 : 328;

// Vérifier simultanément le montant et la devise
if (
  !Number.isSafeInteger(totalXof) ||
  !Number.isSafeInteger(expectedAmount) ||
  expectedAmount < minimumAmount ||
  expectedAmount > 99999999 ||
  session.currency !== expectedCurrency ||
  session.amount_total !== expectedAmount
) {
  throw new Error("Montant ou devise Stripe non conforme");
}
      if (order.status !== "pending") return; // Webhook deja traite
      const available = articles.every(a => {
        const p = db.prepare("SELECT stock FROM products WHERE id = ?").get(a.product_id);
        return p && Number.isSafeInteger(a.quantity) && a.quantity > 0 &&
          p.stock >= a.quantity;
      });
      if (!available) {
        db.prepare("UPDATE orders SET status = 'paid', fulfillment_status = 'stock_issue' WHERE id = ? AND status = 'pending'").run(orderId);
        return;
      }
      for (const a of articles) {
        const result = db.prepare(
          "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
        ).run(a.quantity, a.product_id, a.quantity);
        if (result.changes !== 1) throw new Error("Stock non actualise");
      }
      const result = db.prepare(
        "UPDATE orders SET status = 'paid', fulfillment_status = 'pending' WHERE id = ? AND status = 'pending'"
      ).run(orderId);
      if (result.changes !== 1) throw new Error("Commande non confirmee");
    });
    confirm();
    return res.json({ received: true });
  } catch (error) {
    if (error.code === "STRIPE_SESSION_PENDING") {
      console.warn("Webhook Stripe recu avant enregistrement de la session : nouvelle tentative attendue");
      res.set("Retry-After", "5");
      return res.status(503).send("Session Stripe en cours d'enregistrement");
    }
    console.error("Erreur webhook Stripe:", error);
    return res.status(500).send("Verification Stripe impossible");
  }
});

app.use(express.json({ limit: "30kb" }));

// =====================================
// BASE DE DONNÃ‰ES
// =====================================

const dataDir = process.env.DATA_DIR ||
  path.join(__dirname, "data");

const uploadDir = path.join(dataDir, "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(
  path.join(dataDir, "shop.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    customer TEXT NOT NULL,
    invoice_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
    CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// =====================================
// SUIVI DE PRÃ‰PARATION DES COMMANDES
// =====================================

const colonnesOrders = db.prepare(
  "PRAGMA table_info(orders)"
).all();

const fulfillmentExiste = colonnesOrders.some(
  colonne => colonne.name === "fulfillment_status"
);

if (!fulfillmentExiste) {
  db.exec(`
    ALTER TABLE orders
    ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'pending'
  `);

  console.log("Colonne fulfillment_status ajoutée");
}


// Identifier le fournisseur de paiement des commandes.
const paymentProviderExiste = db.prepare(
  "PRAGMA table_info(orders)"
).all().some(colonne => colonne.name === "payment_provider");

if (!paymentProviderExiste) {
  db.exec("ALTER TABLE orders ADD COLUMN payment_provider TEXT");
  console.log("Colonne payment_provider ajoutee");
}

// =====================================
// SUIVI DES COLIS - BASE DE DONNEES
// =====================================
const colonnesSuivi = db.prepare(
  "PRAGMA table_info(orders)"
).all().map(colonne => colonne.name);

const champsSuivi = [
  "shipping_carrier",
  "tracking_number",
  "tracking_url",
  "shipped_at"
];

for (const champ of champsSuivi) {
  if (!colonnesSuivi.includes(champ)) {
    const type = champ === "shipped_at" ? "INTEGER" : "TEXT";

    db.exec(
      `ALTER TABLE orders ADD COLUMN ${champ} ${type}`
    );

    console.log("Colonne de suivi ajoutée :", champ);
  }
}
// =====================================
// COMMANDES FICTIVES - TESTS ADMIN
// =====================================
db.exec(`
  CREATE TABLE IF NOT EXISTS test_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fulfillment_status TEXT NOT NULL DEFAULT 'pending',
    shipping_carrier TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    shipped_at INTEGER,
    created_at INTEGER NOT NULL
  );
`);
const clean = product => ({
  ...product,
  images: JSON.parse(product.images)
});


function getProduct(id) {

  // Produit temporaire Stripe : interdit aux nouvelles commandes
  if (Number(id) === 28) {
    return null;
  }

  const product = db.prepare(
    "SELECT * FROM products WHERE id = ?"
  ).get(id);

  return product ? clean(product) : null;
}
// =====================================
// IMPORTATION DES PRODUITS EXISTANTS
// =====================================

const produitsInitiaux = [
  {
    id: 1,
    name: "Produit 1",
    price: 6600,
    stock: 5,
    images: ["gf.jpeg", "gd.jpeg", "gh.jpeg"],
    description: "Nouvelle robe plissée élégante et tendance pour femmes, col en V, idéale pour les trajets quotidiens au printemps/automne"
  },
  {
    id: 2,
    name: "Produit 2",
    price: 5500,
    stock: 10,
    images: ["pe.jpeg", "pg.jpeg", "pd.jpeg"],
    description: "Brosse à cheveux électrique 2-en-1 pour lisser et boucler, utilisation sur cheveux secs ou humides"
  },
  {
    id: 3,
    name: "Produit 3",
    price: 7800,
    stock: 8,
    images: ["se.jpeg", "sr.jpeg", "st.jpeg"],
    description: "Mini sac bandoulière carré avec fermeture éclair et chaîne dorée"
  },
  {
    id: 4,
    name: "Produit 4",
    price: 7900,
    stock: 12,
    images: ["ro.jpeg", "rb.jpeg", "re.jpeg"],
    description: "Robe de mariée élégante avec imprimé floral, design à une épaule et coupe longue"
  },
  {"id": 5, "name": "Produit 5", "price": 7000, "stock": 6, "images": ["p5-1.jpeg", "p5-2.jpeg", "p5-3.jpeg"], "description": "â€¢ Bonne finition<br>â€¢ Produit populaire"},
  {"id": 6, "name": "Produit 6", "price": 7500, "stock": 9, "images": ["p6-1.jpeg", "p6-2.jpeg", "p6-3.jpeg"], "description": "â€¢ Très bonne qualité<br>â€¢ Livraison disponible"},
  {"id": 7, "name": "Produit 7", "price": 8000, "stock": 7, "images": ["p7-1.jpeg", "p7-2.jpeg", "p7-3.jpeg"], "description": "â€¢ Design moderne<br>â€¢ Disponible"},
  {"id": 8, "name": "Produit 8", "price": 8500, "stock": 11, "images": ["p8-1.jpeg", "p8-2.jpeg", "p8-3.jpeg"], "description": "â€¢ Produit vérifié<br>â€¢ Qualité premium"},
  {"id": 9, "name": "Produit 9", "price": 9000, "stock": 5, "images": ["p9-1.jpeg", "p9-2.jpeg", "p9-3.jpeg"], "description": "â€¢ Livraison Sénégal<br>â€¢ Bon état"},
  {"id": 10, "name": "Produit 10", "price": 9500, "stock": 15, "images": ["p10-1.jpeg", "p10-2.jpeg", "p10-3.jpeg"], "description": "â€¢ Produit populaire<br>â€¢ Disponible"},
  {"id": 11, "name": "Produit 11", "price": 10000, "stock": 4, "images": ["p11-1.jpeg", "p11-2.jpeg", "p11-3.jpeg"], "description": "â€¢ Bonne qualité<br>â€¢ Livraison rapide"},
  {"id": 12, "name": "Produit 12", "price": 10500, "stock": 6, "images": ["p12-1.jpeg", "p12-2.jpeg", "p12-3.jpeg"], "description": "â€¢ Produit original<br>â€¢ Disponible"},
  {"id": 13, "name": "Produit 13", "price": 11000, "stock": 8, "images": ["p13-1.jpeg", "p13-2.jpeg", "p13-3.jpeg"], "description": "â€¢ Très demandé<br>â€¢ Haute qualité"},
  {"id": 14, "name": "Produit 14", "price": 11500, "stock": 10, "images": ["p14-1.jpeg", "p14-2.jpeg", "p14-3.jpeg"], "description": "â€¢ Design élégant<br>â€¢ Livraison possible"},
  {"id": 15, "name": "Produit 15", "price": 12000, "stock": 5, "images": ["p15-1.jpeg", "p15-2.jpeg", "p15-3.jpeg"], "description": "â€¢ Produit neuf<br>â€¢ Disponible maintenant"},
  {"id": 16, "name": "Produit 16", "price": 12500, "stock": 6, "images": ["p16-1.jpeg", "p16-2.jpeg", "p16-3.jpeg"], "description": "â€¢ Bonne finition<br>â€¢ Produit vérifié"},
  {"id": 17, "name": "Produit 17", "price": 13000, "stock": 7, "images": ["p17-1.jpeg", "p17-2.jpeg", "p17-3.jpeg"], "description": "â€¢ Qualité premium<br>â€¢ Disponible"},
  {"id": 18, "name": "Produit 18", "price": 13500, "stock": 8, "images": ["p18-1.jpeg", "p18-2.jpeg", "p18-3.jpeg"], "description": "â€¢ Livraison rapide<br>â€¢ Bon produit"},
  {"id": 19, "name": "Produit 19", "price": 14000, "stock": 9, "images": ["p19-1.jpeg", "p19-2.jpeg", "p19-3.jpeg"], "description": "â€¢ Très bonne qualité<br>â€¢ Disponible"},
  {"id": 20, "name": "Produit 20", "price": 14500, "stock": 10, "images": ["p20-1.jpeg", "p20-2.jpeg", "p20-3.jpeg"], "description": "â€¢ Produit tendance<br>â€¢ Livraison Sénégal"},
  {"id": 21, "name": "Produit 21", "price": 15000, "stock": 5, "images": ["p21-1.jpeg", "p21-2.jpeg", "p21-3.jpeg"], "description": "â€¢ Produit premium<br>â€¢ Disponible"},
  {"id": 22, "name": "Produit 22", "price": 15500, "stock": 6, "images": ["p22-1.jpeg", "p22-2.jpeg", "p22-3.jpeg"], "description": "â€¢ Design moderne<br>â€¢ Haute qualité"},
  {"id": 23, "name": "Produit 23", "price": 16000, "stock": 7, "images": ["p23-1.jpeg", "p23-2.jpeg", "p23-3.jpeg"], "description": "â€¢ Produit neuf<br>â€¢ Disponible"},
  {"id": 24, "name": "Produit 24", "price": 16500, "stock": 8, "images": ["p24-1.jpeg", "p24-2.jpeg", "p24-3.jpeg"], "description": "â€¢ Livraison rapide<br>â€¢ Produit vérifié"},
  {"id": 25, "name": "Produit 25", "price": 17000, "stock": 9, "images": ["p25-1.jpeg", "p25-2.jpeg", "p25-3.jpeg"], "description": "â€¢ Très populaire<br>â€¢ Disponible"},
  {"id": 26, "name": "Produit 26", "price": 17500, "stock": 10, "images": ["p26-1.jpeg", "p26-2.jpeg", "p26-3.jpeg"], "description": "â€¢ Bonne qualité<br>â€¢ Livraison Sénégal"},
  {"id": 27, "name": "Produit 27", "price": 18000, "stock": 5, "images": ["p27-1.jpeg", "p27-2.jpeg", "p27-3.jpeg"], "description": "â€¢ Produit premium<br>â€¢ Disponible maintenant"}
];

// Importer les produits sans écraser ceux qui existent déjà

const importerProduit = db.prepare(`
  INSERT OR IGNORE INTO products
  (id, name, price, stock, description, images)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const importerProduits = db.transaction(() => {

  for (const produit of produitsInitiaux) {

    importerProduit.run(
      produit.id,
      produit.name,
      produit.price,
      produit.stock,
      produit.description,
      JSON.stringify(produit.images)
    );

  }

});

importerProduits();

console.log("Importation des produits terminée");

// =====================================
// PHOTOS DES PRODUITS
// =====================================

app.use(
  "/uploads",
  express.static(uploadDir, {
    fallthrough: false,
    maxAge: "1d"
  })
);

// =====================================
// ROUTES PUBLIQUES
// =====================================

app.get("/", (req, res) => {
  res.send("Backend DJIBY SHOP fonctionne ðŸ”¥");
});

app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "HTML connecté au backend ðŸ”¥"
  });
});

app.get("/products", (req, res) => {
  const products = db.prepare(
    "SELECT * FROM products WHERE id != 28 ORDER BY id DESC"
  ).all().map(clean);

  res.json(products);
});

// =====================================
// CONNEXION ADMINISTRATEUR
// =====================================

const failed = new Map();

app.post("/admin/login", async (req, res) => {

  const ip = req.ip;

  const record = failed.get(ip) || {
    count: 0,
    until: 0
  };

  if (
    record.count >= 5 &&
    Date.now() < record.until
  ) {
    return res.status(429).json({
      message: "Trop de tentatives. Réessayez dans 15 minutes."
    });
  }

  const ok =
    typeof req.body.password === "string" &&
    await bcrypt.compare(
      req.body.password,
      process.env.ADMIN_PASSWORD_HASH
    );

  if (!ok) {

    const count = record.count + 1;

    failed.set(ip, {
      count,
      until: Date.now() + 15 * 60 * 1000
    });

    return res.status(401).json({
      message: "Mot de passe incorrect"
    });
  }

  failed.delete(ip);

  const token = crypto.randomBytes(32).toString("hex");

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  db.prepare(`
    INSERT INTO admin_sessions
    (token_hash, expires_at)
    VALUES (?, ?)
  `).run(
    tokenHash,
    Date.now() + 8 * 3600 * 1000
  );

  res.json({ token });
});

// =====================================
// PROTECTION ADMINISTRATEUR
// =====================================

function admin(req, res, next) {

  const authorization =
    req.get("authorization") || "";

  const token = authorization.match(
    /^Bearer ([a-f0-9]{64})$/
  )?.[1];

  if (!token) {
    return res.status(401).json({
      message: "Connexion administrateur requise"
    });
  }

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const session = db.prepare(`
    SELECT 1 FROM admin_sessions
    WHERE token_hash = ?
    AND expires_at > ?
  `).get(hash, Date.now());

  if (!session) {
    return res.status(401).json({
      message: "Session expirée"
    });
  }

  req.tokenHash = hash;

  next();
}

// =====================================
// COMMANDES CLIENTS - ADMINISTRATION
// =====================================
app.get("/admin/orders", admin, (req, res) => {
  try {
    const commandes = db.prepare(`
      SELECT
        id,
        customer,
        status,
        payment_provider,
        fulfillment_status,
        shipping_carrier,
        tracking_number,
        tracking_url,
        shipped_at,
        created_at
      FROM orders
      ORDER BY created_at DESC, id DESC
      LIMIT 100
    `).all();

    const articlesStmt = db.prepare(`
      SELECT
        oi.product_id,
        oi.quantity,
        oi.unit_price,
        p.name AS product_name
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
    `);

    const resultat = commandes.map(commande => {
      const articles = articlesStmt.all(commande.id);

      let client = {};
      try {
        client = JSON.parse(commande.customer);
      } catch {
        client = {};
      }

      return {
        id: commande.id,
        customer: client,
        status: commande.status,
        payment_provider: commande.payment_provider,
        fulfillment_status: commande.fulfillment_status,
        shipping_carrier: commande.shipping_carrier,
        tracking_number: commande.tracking_number,
        tracking_url: commande.tracking_url,
        shipped_at: commande.shipped_at,
        created_at: commande.created_at,
        items: articles,
        total_xof: articles.reduce(
          (total, article) =>
            total + article.quantity * article.unit_price,
          0
        )
      };
    });

    res.json({ success: true, orders: resultat });

  } catch (error) {
    console.error("Erreur commandes admin:", error);
    res.status(500).json({
      success: false,
      message: "Impossible de charger les commandes"
    });
  }
});
// =====================================
// SUIVI DES LIVRAISONS - ADMINISTRATION
// =====================================
app.patch("/admin/orders/:id/fulfillment", admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const nouveauStatut = req.body?.fulfillment_status;

    const statuts = [
      "pending",
      "preparing",
      "shipped",
      "delivered"
    ];

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Identifiant de commande invalide"
      });
    }

    if (!statuts.includes(nouveauStatut)) {
      return res.status(400).json({
        success: false,
        message: "Statut de livraison invalide"
      });
    }

    const commande = db.prepare(`
      SELECT id, status, fulfillment_status
      FROM orders
      WHERE id = ?
    `).get(id);

    if (!commande) {
      return res.status(404).json({
        success: false,
        message: "Commande introuvable"
      });
    }

    if (commande.status !== "paid") {
      return res.status(409).json({
        success: false,
        message: "Le paiement doit être confirmé"
      });
    }

    if (commande.fulfillment_status === "stock_issue") {
      return res.status(409).json({
        success: false,
        message: "Problème de stock à résoudre"
      });
    }

    const transitions = {
      pending: ["preparing"],
      preparing: ["shipped"],
      shipped: ["delivered"],
      delivered: []
    };

    if (!transitions[commande.fulfillment_status]?.includes(nouveauStatut)) {
      return res.status(409).json({
        success: false,
        message: "Changement de statut non autorisé"
      });
    }

    let resultat;

    if (nouveauStatut === "shipped") {
      const carrier = req.body?.shipping_carrier;
      const tracking = req.body?.tracking_number;
      const url = req.body?.tracking_url || "";

      if (
        typeof carrier !== "string" ||
        typeof tracking !== "string" ||
        typeof url !== "string" ||
        !carrier.trim() ||
        !tracking.trim() ||
        carrier.trim().length > 100 ||
        tracking.trim().length > 150 ||
        url.length > 500
      ) {
        return res.status(400).json({
          success: false,
          message: "Transporteur ou numéro de suivi invalide"
        });
      }

      if (url.trim()) {
        try {
          const lien = new URL(url.trim());

          if (!["https:", "http:"].includes(lien.protocol)) {
            throw new Error("Protocole invalide");
          }
        } catch {
          return res.status(400).json({
            success: false,
            message: "Lien de suivi invalide"
          });
        }
      }

      resultat = db.prepare(`
        UPDATE orders
        SET fulfillment_status = 'shipped',
            shipping_carrier = ?,
            tracking_number = ?,
            tracking_url = ?,
            shipped_at = ?
        WHERE id = ?
          AND status = 'paid'
          AND fulfillment_status = 'preparing'
      `).run(
        carrier.trim(),
        tracking.trim(),
        url.trim(),
        Date.now(),
        id
      );

    } else {
      resultat = db.prepare(`
        UPDATE orders
        SET fulfillment_status = ?
        WHERE id = ?
          AND status = 'paid'
          AND fulfillment_status = ?
      `).run(nouveauStatut, id, commande.fulfillment_status);
    }

    if (resultat.changes !== 1) {
      return res.status(409).json({
        success: false,
        message: "La commande a changé. Actualisez la liste."
      });
    }

    res.json({
      success: true,
      message: "Statut de livraison actualisé",
      fulfillment_status: nouveauStatut
    });

  } catch (error) {
    console.error("Erreur suivi livraison:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de modifier la livraison"
    });
  }
});
// =====================================
// CREATION DES COMMANDES DE TEST
// =====================================
app.post("/admin/test-orders", admin, (req, res) => {
  try {
    const resultat = db.prepare(`
      INSERT INTO test_orders (
        fulfillment_status,
        created_at
      )
      VALUES ('pending', ?)
    `).run(Date.now());

    res.status(201).json({
      success: true,
      message: "Commande de test créée",
      order: {
        id: resultat.lastInsertRowid,
        fulfillment_status: "pending",
        is_test: true
      }
    });

  } catch (error) {
    console.error("Erreur création commande test:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de créer la commande de test"
    });
  }
});
// =====================================
// LISTE DES COMMANDES FICTIVES
// =====================================
app.get("/admin/test-orders", admin, (req, res) => {
  try {
    const commandes = db.prepare(`
      SELECT
        id,
        fulfillment_status,
        shipping_carrier,
        tracking_number,
        tracking_url,
        shipped_at,
        created_at
      FROM test_orders
      ORDER BY id DESC
      LIMIT 50
    `).all();

    res.json({
      success: true,
      orders: commandes.map(commande => ({
        ...commande,
        is_test: true
      }))
    });

  } catch (error) {
    console.error("Erreur liste commandes test:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de charger les commandes de test"
    });
  }
});
// =====================================
// LIVRAISONS DES COMMANDES FICTIVES
// =====================================
app.patch("/admin/test-orders/:id/fulfillment", admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const nouveauStatut = req.body?.fulfillment_status;

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Identifiant de test invalide"
      });
    }

    const transitions = {
      pending: "preparing",
      preparing: "shipped",
      shipped: "delivered"
    };

    const commande = db.prepare(`
      SELECT id, fulfillment_status
      FROM test_orders
      WHERE id = ?
    `).get(id);

    if (!commande) {
      return res.status(404).json({
        success: false,
        message: "Commande de test introuvable"
      });
    }

    if (transitions[commande.fulfillment_status] !== nouveauStatut) {
      return res.status(409).json({
        success: false,
        message: "Transition de livraison non autorisée"
      });
    }

    let resultat;

    if (nouveauStatut === "shipped") {
      const carrier = req.body?.shipping_carrier;
      const tracking = req.body?.tracking_number;
      const url = req.body?.tracking_url ?? "";

      if (
        typeof carrier !== "string" ||
        typeof tracking !== "string" ||
        typeof url !== "string" ||
        !carrier.trim() ||
        !tracking.trim() ||
        carrier.trim().length > 100 ||
        tracking.trim().length > 150 ||
        url.length > 500
      ) {
        return res.status(400).json({
          success: false,
          message: "Informations de suivi invalides"
        });
      }

      if (url.trim()) {
        try {
          const lien = new URL(url.trim());
          if (!["https:", "http:"].includes(lien.protocol)) {
            throw new Error("Protocole interdit");
          }
        } catch {
          return res.status(400).json({
            success: false,
            message: "Lien de suivi invalide"
          });
        }
      }

      resultat = db.prepare(`
        UPDATE test_orders
        SET fulfillment_status = 'shipped',
            shipping_carrier = ?,
            tracking_number = ?,
            tracking_url = ?,
            shipped_at = ?
        WHERE id = ?
          AND fulfillment_status = 'preparing'
      `).run(
        carrier.trim(),
        tracking.trim(),
        url.trim(),
        Date.now(),
        id
      );

    } else {
      resultat = db.prepare(`
        UPDATE test_orders
        SET fulfillment_status = ?
        WHERE id = ?
          AND fulfillment_status = ?
      `).run(nouveauStatut, id, commande.fulfillment_status);
    }

    if (resultat.changes !== 1) {
      return res.status(409).json({
        success: false,
        message: "La commande de test a changé. Actualisez."
      });
    }

    res.json({
      success: true,
      fulfillment_status: nouveauStatut
    });

  } catch (error) {
    console.error("Erreur livraison test:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de modifier la commande de test"
    });
  }
});
// =====================================
// SUPPRESSION DES COMMANDES FICTIVES
// =====================================
app.delete("/admin/test-orders/:id", admin, (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Identifiant de test invalide"
      });
    }

    const resultat = db.prepare(`
      DELETE FROM test_orders
      WHERE id = ?
    `).run(id);

    if (resultat.changes === 0) {
      return res.status(404).json({
        success: false,
        message: "Commande fictive introuvable"
      });
    }

    res.json({
      success: true,
      message: "Commande fictive supprimée"
    });

  } catch (error) {
    console.error("Erreur suppression commande test:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de supprimer la commande fictive"
    });
  }
});
app.get("/admin/check", admin, (req, res) => {
  res.json({ success: true });
});

app.post("/admin/logout", admin, (req, res) => {

  db.prepare(`
    DELETE FROM admin_sessions
    WHERE token_hash = ?
  `).run(req.tokenHash);

  res.json({ success: true });
});

// =====================================
// AJOUTER DES PHOTOS
// =====================================

const upload = multer({

  storage: multer.diskStorage({

    destination: uploadDir,

    filename(req, file, callback) {

      const extension =
        file.mimetype === "image/png"
          ? ".png"
          : file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";

      callback(
        null,
        crypto.randomUUID() + extension
      );
    }
  }),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5
  },

  fileFilter(req, file, callback) {

    callback(
      null,
      [
        "image/jpeg",
        "image/png",
        "image/webp"
      ].includes(file.mimetype)
    );
  }
});

app.post("/admin/upload", admin, (req, res) => {
  upload.array("photos", 5)(
    req,
    res,
    error => {

      if (error) {
        return res.status(400).json({
          message: error.message
        });
      }

      if (!req.files?.length) {
        return res.status(400).json({
          message: "Images JPEG, PNG ou WebP requises"
        });
      }

      res.json({
        images: req.files.map(
          file => "/uploads/" + file.filename
        )
      });
    }
  );
});

// =====================================
// VALIDATION DES PRODUITS
// =====================================

function validated(body) {

  const name = String(
    body.name || ""
  ).trim().slice(0, 150);

  const price = Number(body.price);
  const stock = Number(body.stock);

  const description = String(
    body.description || ""
  ).slice(0, 3000);

  const images = body.images;

  if (
    !name ||
    !Number.isSafeInteger(price) ||
    price <= 0 ||
    !Number.isSafeInteger(stock) ||
    stock < 0 ||
    !Array.isArray(images) ||
    images.length > 12 ||
    !images.every(
      image =>
        typeof image === "string" &&
        (
          image.startsWith("/uploads/") ||
          /^https:\/\//.test(image)
        )
    )
  ) {
    return null;
  }

  return {
    name,
    price,
    stock,
    description,
    images: JSON.stringify(images)
  };
}

// =====================================
// CRÃ‰ER UN PRODUIT
// =====================================

app.post("/admin/products", admin, (req, res) => {

  const product = validated(req.body);

  if (!product) {
    return res.status(400).json({
      message: "Produit invalide"
    });
  }

  const result = db.prepare(`
    INSERT INTO products
    (name, price, stock, description, images)
    VALUES
    (@name, @price, @stock, @description, @images)
  `).run(product);

  res.status(201).json(
    getProduct(result.lastInsertRowid)
  );
});

// =====================================
// MODIFIER UN PRODUIT
// =====================================

app.put("/admin/products/:id", admin, (req, res) => {

  if (!getProduct(req.params.id)) {
    return res.status(404).json({
      message: "Produit introuvable"
    });
  }
  const product = validated(req.body);

  if (!product) {
    return res.status(400).json({
      message: "Produit invalide"
    });
  }

  db.prepare(`
    UPDATE products
    SET
      name = @name,
      price = @price,
      stock = @stock,
      description = @description,
      images = @images
    WHERE id = @id
  `).run({
    ...product,
    id: req.params.id
  });

  res.json(getProduct(req.params.id));
});

// =====================================
// SUPPRIMER UN PRODUIT
// =====================================

app.delete("/admin/products/:id", admin, (req, res) => {

  db.prepare(
    "DELETE FROM products WHERE id = ?"
  ).run(req.params.id);

  res.json({ success: true });
});

// =====================================
// CONFIGURATION PAYDUNYA
// =====================================

let setup = null;
let store = null;

if (PAYDUNYA_ENABLED) {

  const requiredKeys = [
    "PAYDUNYA_MASTER_KEY",
    "PAYDUNYA_PRIVATE_KEY",
    "PAYDUNYA_PUBLIC_KEY",
    "PAYDUNYA_TOKEN"
  ];

  const missingKeys = requiredKeys.filter(
    key => !process.env[key]
  );

  if (missingKeys.length > 0) {
    throw new Error(
      "Configuration PayDunya incomplète"
    );
  }

  setup = new paydunya.Setup({
    masterKey: process.env.PAYDUNYA_MASTER_KEY,
    privateKey: process.env.PAYDUNYA_PRIVATE_KEY,
    publicKey: process.env.PAYDUNYA_PUBLIC_KEY,
    token: process.env.PAYDUNYA_TOKEN,
    mode: process.env.PAYDUNYA_MODE || "test"
  });

  store = new paydunya.Store({
    name: "DJIBY SHOP",
    tagline: "Produits de qualité",
    phoneNumber: "33745098191",
    websiteURL: SITE_URL
  });

}
// =====================================
// CRÃ‰ER UN PAIEMENT
// =====================================

app.post("/create-payment", async (req, res) => {

    if (!PAYDUNYA_ENABLED) {
    return res.status(503).json({
      error: "PayDunya désactivé sur ce serveur"
    });
  }

  try {

    const product = getProduct(
      req.body?.product?.id
    );

    const customer = req.body?.customer;

    if (
      !product ||
      !customer ||
      ![
        "firstName",
        "lastName",
        "email",
        "phone",
        "address"
      ].every(
        key =>
          typeof customer[key] === "string" &&
          customer[key].trim().length > 0 &&
          customer[key].length < 250
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Produit ou client invalide"
      });
    }

    if (product.stock <= 0) {
      return res.json({
        success: false,
        message: "Produit indisponible"
      });
    }

    const invoice = new paydunya.CheckoutInvoice(
      setup,
      store
    );

    const details =
      `Client: ${customer.firstName} ${customer.lastName} | ` +
      `Email: ${customer.email} | ` +
      `Téléphone: ${customer.phone} | ` +
      `Adresse: ${customer.address}`;

    invoice.addItem(
      product.name,
      1,
      product.price,
      product.price,
      details
    );

    invoice.totalAmount = product.price;

    invoice.returnURL =
      SITE_URL + "/success.html";

    invoice.callbackURL =
      process.env.PUBLIC_API_URL + "/ipn";

    invoice.description =
      "Merci de commander chez DJIBY SHOP. Livraison disponible.";

    await invoice.create();

    if (!invoice.url || !invoice.token) {
  throw new Error(
    "Lien ou token de paiement indisponible"
  );
}

    db.prepare(`
      INSERT INTO orders (product_id, customer, invoice_token, status, created_at, payment_provider) VALUES (?, ?, ?, ?, ?, 'paydunya')
    `).run(
      product.id,
      JSON.stringify(customer),
      invoice.token || null,
      "pending",
      Date.now()
    );

    // Le stock ne diminue pas avant
    // confirmation vérifiée du paiement.

    res.json({
      success: true,
      status: "en attente",
      payment_url: invoice.url
    });

  } catch (error) {

    console.error("Erreur PayDunya:", error);

    res.status(500).json({
      success: false,
      message: "Impossible de créer le paiement"
    });
  }
});

// =====================================
// PAIEMENT DU PANIER
// =====================================

app.post("/create-cart-payment", async (req, res) => {

    if (!PAYDUNYA_ENABLED) {
    return res.status(503).json({
      error: "PayDunya désactivé sur ce serveur"
    });
  }
  try {
    const items = req.body?.items;
    const customer = req.body?.customer;

    // Vérifier les informations du client
    const champs = [
      "firstName",
      "lastName",
      "email",
      "phone",
      "address"
    ];

    if (
      !customer ||
      !champs.every(
        key =>
          typeof customer[key] === "string" &&
          customer[key].trim().length > 0 &&
          customer[key].length < 250
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Informations client invalides"
      });
    }

    // Vérifier le panier
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Panier invalide"
      });
    }

    const produits = [];
    const ids = new Set();
    let total = 0;

    for (const item of items) {
      const id = Number(item?.id);
      const quantity = Number(item?.quantity);

      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100 ||
        ids.has(id)
      ) {
        return res.status(400).json({
          success: false,
          message: "Produit ou quantité invalide"
        });
      }

      ids.add(id);

      const product = getProduct(id);

      if (!product || product.stock < quantity) {
        return res.status(400).json({
          success: false,
          message: "Stock insuffisant pour un produit"
        });
      }

      const sousTotal = product.price * quantity;

      if (
        !Number.isSafeInteger(sousTotal) ||
        !Number.isSafeInteger(total + sousTotal)
      ) {
        return res.status(400).json({
          success: false,
          message: "Montant invalide"
        });
      }

      total += sousTotal;

      produits.push({
        ...product,
        quantity,
        sousTotal
      });
    }

    // Créer une facture PayDunya
    const invoice = new paydunya.CheckoutInvoice(setup, store);

    for (const product of produits) {
      invoice.addItem(
        product.name,
        product.quantity,
        product.price,
        product.sousTotal
      );
    }

    invoice.totalAmount = total;

    invoice.returnURL = SITE_URL + "/success.html";
    invoice.callbackURL = process.env.PUBLIC_API_URL + "/ipn";

    invoice.description =
      "Commande panier DJIBY SHOP";

    await invoice.create();

    if (!invoice.url || !invoice.token) {
      throw new Error("Facture PayDunya incomplète");
    }

    // Enregistrer la commande et ses articles ensemble
    const enregistrerCommande = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO orders (product_id, customer, invoice_token, status, created_at, payment_provider) VALUES (?, ?, ?, 'pending', ?, 'paydunya')
      `).run(
        produits[0].id,
        JSON.stringify(customer),
        invoice.token,
        Date.now()
      );

      const insertItem = db.prepare(`
        INSERT INTO order_items
        (order_id, product_id, quantity, unit_price)
        VALUES (?, ?, ?, ?)
      `);

      for (const product of produits) {
        insertItem.run(
          result.lastInsertRowid,
          product.id,
          product.quantity,
          product.price
        );
      }
    });

    enregistrerCommande();

    res.json({
      success: true,
      status: "en attente",
      payment_url: invoice.url
    });

  } catch (error) {
    console.error("Erreur paiement panier :", error);

    res.status(500).json({
      success: false,
      message: "Impossible de créer le paiement du panier"
    });
  }
});

// =====================================
// PAIEMENT STRIPE (PANIER EN FCFA, REGLEMENT EN EUR)
// =====================================
app.get("/stripe-payment-status", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!stripe) {
    return res.status(503).json({ status: "unavailable" });
  }

  const sessionId = req.query.session_id;

  if (
    typeof sessionId !== "string" ||
    !/^cs_(test_|live_)[A-Za-z0-9]+$/.test(sessionId)
  ) {
    return res.status(400).json({ status: "invalid" });
  }

  try {
    const order = db.prepare(
      "SELECT id, status, invoice_token FROM orders WHERE invoice_token = ?"
    ).get(sessionId);

    if (!order) {
      return res.status(404).json({ status: "not_found" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.id !== order.invoice_token ||
      session.mode !== "payment" ||
      session.metadata?.order_id !== String(order.id) ||
      session.currency !== "eur"
    ) {
      return res.status(409).json({ status: "unverified" });
    }

    if (session.payment_status !== "paid") {
      return res.json({ status: "pending" });
    }

    if (order.status !== "paid") {
      return res.json({ status: "processing" });
    }

    return res.json({ status: "paid" });

  } catch (error) {
    console.error("Erreur verification Stripe:", error.message);
    return res.status(503).json({ status: "unavailable" });
  }
});

// Route publique : reste bloquee tant que Stripe n'est pas ouvert aux clients.
app.post("/create-stripe-payment", (req, res) => {
  if (process.env.STRIPE_PAYMENTS_ENABLED !== "true") {
    return res.status(503).json({
      success: false,
      message: "Paiement Stripe temporairement indisponible"
    });
  }
  return createStripePayment(req, res);
});

// Route de verification reservee a l'administrateur.
// STRIPE_TEST_MODE=true autorise cette route et les webhooks,
// mais N'ACTIVE PAS le paiement Stripe pour les visiteurs.
app.post("/admin/create-stripe-test-payment", admin, (req, res) => {
  if (process.env.STRIPE_TEST_MODE !== "true") {
    return res.status(503).json({ success: false, message: "Test Stripe desactive" });
  }
  if (process.env.STRIPE_PAYMENTS_ENABLED === "true") {
    return res.status(409).json({ success: false, message: "Stripe public deja actif" });
  }
  return createStripePayment(req, res);
});

// SUNU SHOP : déterminer la devise selon le pays
function getStripeCurrencyByCountry(country) {

  const xofCountries = [
    "SN", "CI", "ML", "BF",
    "BJ", "TG", "NE", "GW"
  ];

  const xafCountries = [
    "CM", "GA", "CG",
    "TD", "CF", "GQ"
  ];

  const eurCountries = [
    "FR", "DE", "BE", "ES", "IT",
    "PT", "NL", "LU", "AT", "IE",
    "FI", "GR", "HR", "SI", "SK",
    "EE", "LV", "LT", "MT", "CY",
    "BG", "AD", "MC", "SM", "VA",
    "ME", "XK"
  ];

  if (xofCountries.includes(country)) {
    return "xof";
  }

  if (xafCountries.includes(country)) {
    return "xaf";
  }

  if (eurCountries.includes(country)) {
    return "eur";
  }

  return null;
}

async function createStripePayment(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, message: "Stripe non configure" });
  }
  const items = req.body?.items;
  const customer = req.body?.customer;
  const fields = ["firstName", "lastName", "email", "phone", "address", "country"];
  if (!customer || !fields.every(key =>
    typeof customer[key] === "string" &&
    customer[key].trim().length > 0 && customer[key].length < 250
  ) || !Array.isArray(items) || items.length < 1 || items.length > 30) {
    return res.status(400).json({ success: false, message: "Panier ou client invalide" });
  }

  // Déterminer la devise Stripe selon le pays du client
const stripeCurrency = getStripeCurrencyByCountry(customer.country);

if (!stripeCurrency) {
  return res.status(400).json({
    success: false,
    message: "Pays non pris en charge pour le paiement Stripe"
  });
}

  const products = [];
  const ids = new Set();
  let totalXof = 0;
  for (const item of items) {
    const id = Number(item?.id);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 ||
        ids.has(id)) {
      return res.status(400).json({ success: false, message: "Article invalide" });
    }
    ids.add(id);
    const product = getProduct(id);
    if (!product || product.stock < quantity) {
      return res.status(400).json({ success: false, message: "Stock insuffisant" });
    }
    const subtotal = product.price * quantity;
    if (!Number.isSafeInteger(subtotal) ||
        !Number.isSafeInteger(totalXof + subtotal)) {
      return res.status(400).json({ success: false, message: "Montant invalide" });
    }
    totalXof += subtotal;
    products.push({ ...product, quantity });
  }

// SUNU SHOP : calcul du montant selon la devise
// EUR : centimes
// XOF et XAF : unités entières, sans centimes

const stripeAmount =
  stripeCurrency === "eur"
    ? Math.round(totalXof * 100 / 655.957)
    : totalXof;

// Vérification du montant
const minimumAmount =
  stripeCurrency === "eur" ? 50 : 328;

if (
  !Number.isSafeInteger(stripeAmount) ||
  stripeAmount < minimumAmount ||
  stripeAmount > 99999999
) {
  return res.status(400).json({
    success: false,
    message: "Montant non pris en charge"
  });
}
  let orderId;
  try {
    // On enregistre d'abord la commande en attente, sans modifier le stock.
    const insert = db.transaction(() => {
      const order = db.prepare(`
        INSERT INTO orders (product_id, customer, invoice_token, status, created_at, payment_provider) VALUES (?, ?, NULL, 'pending', ?, 'stripe')
      `).run(products[0].id, JSON.stringify(customer), Date.now());
      const add = db.prepare(`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
        VALUES (?, ?, ?, ?)
      `);
      for (const product of products) {
        add.run(order.lastInsertRowid, product.id, product.quantity, product.price);
      }
      return Number(order.lastInsertRowid);
    });
    orderId = insert();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      customer_email: customer.email.trim(),
      client_reference_id: String(orderId),
      metadata: { order_id: String(orderId) },
      line_items: [{

        price_data: {
  currency: stripeCurrency,
  unit_amount: stripeAmount,
  product_data: {
    name: `Commande SunuShop #${orderId} (${totalXof} FCFA)`
  }
},
        quantity: 1
      }],
      success_url: "https://djibymb.github.io/djiby-shop/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://djibymb.github.io/djiby-shop/"
    }, { idempotencyKey: `sunushop-order-${orderId}` });

    db.prepare("UPDATE orders SET invoice_token = ? WHERE id = ? AND status = 'pending'")
      .run(session.id, orderId);
    return res.json({ success: true, payment_url: session.url, status: "en attente" });
  } catch (error) {
    console.error("Erreur creation Stripe:", error);
    return res.status(500).json({ success: false, message: "Paiement Stripe indisponible" });
  }
}

// =====================================
// CONFIRMATION DES PAIEMENTS PAYDUNYA
// =====================================

app.post("/ipn", async function(req, res) {

    if (!PAYDUNYA_ENABLED) {
    return res.status(503).json({
      error: "PayDunya désactivé sur ce serveur"
    });
  }

  try {

    const data = req.body?.data;

    const token = data?.invoice?.token;

    if (!token || typeof token !== "string") {
      return res.status(400).send("Token manquant");
    }

    const commande = db.prepare(`
      SELECT * FROM orders
      WHERE invoice_token = ?
    `).get(token);

    if (!commande) {
      return res.status(404).send("Commande introuvable");
    }
    if (commande.payment_provider && commande.payment_provider !== "paydunya") {
      return res.status(409).send("Fournisseur de paiement incorrect");
    }

    // Vérification du paiement directement
    // auprès de PayDunya

    const invoice = new paydunya.CheckoutInvoice(
      setup,
      store
    );

    await invoice.confirm(token);

    if (invoice.status !== "completed") {
      return res.send("Paiement non confirmé");
    }

    // Ã‰viter de traiter deux fois la même commande

const confirmerCommande = db.transaction(() => {

  // Vérifier que la commande est encore en attente
  const commandeEnAttente = db.prepare(`
    SELECT id, product_id
    FROM orders
    WHERE id = ?
    AND status = 'pending'
  `).get(commande.id);

  if (!commandeEnAttente) {
    return;
  }

  // Récupérer les articles du panier
  const articles = db.prepare(`
    SELECT product_id, quantity
    FROM order_items
    WHERE order_id = ?
  `).all(commande.id);

  // Compatibilité avec les anciennes commandes
  const produitsADecompter = articles.length > 0
    ? articles
    : [{
        product_id: commandeEnAttente.product_id,
        quantity: 1
      }];

  // Vérifier la disponibilité de tous les articles
  let stockDisponible = true;

  for (const article of produitsADecompter) {

    const produit = db.prepare(`
      SELECT stock
      FROM products
      WHERE id = ?
    `).get(article.product_id);

    if (
      !produit ||
      !Number.isSafeInteger(article.quantity) ||
      article.quantity <= 0 ||
      produit.stock < article.quantity
    ) {
      stockDisponible = false;
      break;
    }
  }

  // Paiement confirmé, mais stock insuffisant
  if (!stockDisponible) {

    const resultat = db.prepare(`
      UPDATE orders
      SET status = 'paid',
          fulfillment_status = 'stock_issue'
      WHERE id = ?
      AND status = 'pending'
    `).run(commande.id);

    if (resultat.changes !== 1) {
      throw new Error("Impossible d'enregistrer le paiement");
    }

    console.warn(
      "ATTENTION : paiement confirmé, stock insuffisant pour la commande",
      commande.id
    );

    return;
  }

  // Retirer les articles du stock
  for (const article of produitsADecompter) {

    const resultatStock = db.prepare(`
      UPDATE products
      SET stock = stock - ?
      WHERE id = ?
      AND stock >= ?
    `).run(
      article.quantity,
      article.product_id,
      article.quantity
    );

    if (resultatStock.changes !== 1) {
      throw new Error("Impossible de mettre à jour le stock");
    }
  }

  // Confirmer le paiement
  const resultat = db.prepare(`
    UPDATE orders
    SET status = 'paid',
        fulfillment_status = 'pending'
    WHERE id = ?
    AND status = 'pending'
  `).run(commande.id);

  if (resultat.changes !== 1) {
    throw new Error("Impossible de confirmer la commande");
  }

});

confirmerCommande();

    console.log("Paiement confirmé :", token);

    res.send("ROK");

  } catch(error) {

    console.error(
      "Erreur vérification PayDunya :",
      error
    );

    res.status(500).send("Erreur de vérification");

  }

});
// =====================================
// GESTION DES ERREURS
// =====================================

app.use((error, req, res, next) => {

  res.status(400).json({
    message: error.message || "Requête invalide"
  });
});

// =====================================
// DÃ‰MARRAGE DU SERVEUR
// =====================================

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {

  console.log(
    "Backend lancé sur le port " + PORT
  );
});
