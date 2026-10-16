const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const paydunya = require("paydunya");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();

app.disable("x-powered-by");

const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const SITE_ORIGIN = SITE_URL ? new URL(SITE_URL).origin : "";

if (
  !SITE_URL ||
  !process.env.ADMIN_PASSWORD_HASH ||
  !process.env.PAYDUNYA_MASTER_KEY
) {
  throw new Error(
    "Configurer SITE_URL, ADMIN_PASSWORD_HASH et les variables PAYDUNYA"
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

app.use(express.json({ limit: "30kb" }));

// =====================================
// BASE DE DONNÉES
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
// SUIVI DE PRÉPARATION DES COMMANDES
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


const clean = product => ({
  ...product,
  images: JSON.parse(product.images)
});


function getProduct(id) {
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
  {"id": 5, "name": "Produit 5", "price": 7000, "stock": 6, "images": ["p5-1.jpeg", "p5-2.jpeg", "p5-3.jpeg"], "description": "• Bonne finition<br>• Produit populaire"},
  {"id": 6, "name": "Produit 6", "price": 7500, "stock": 9, "images": ["p6-1.jpeg", "p6-2.jpeg", "p6-3.jpeg"], "description": "• Très bonne qualité<br>• Livraison disponible"},
  {"id": 7, "name": "Produit 7", "price": 8000, "stock": 7, "images": ["p7-1.jpeg", "p7-2.jpeg", "p7-3.jpeg"], "description": "• Design moderne<br>• Disponible"},
  {"id": 8, "name": "Produit 8", "price": 8500, "stock": 11, "images": ["p8-1.jpeg", "p8-2.jpeg", "p8-3.jpeg"], "description": "• Produit vérifié<br>• Qualité premium"},
  {"id": 9, "name": "Produit 9", "price": 9000, "stock": 5, "images": ["p9-1.jpeg", "p9-2.jpeg", "p9-3.jpeg"], "description": "• Livraison Sénégal<br>• Bon état"},
  {"id": 10, "name": "Produit 10", "price": 9500, "stock": 15, "images": ["p10-1.jpeg", "p10-2.jpeg", "p10-3.jpeg"], "description": "• Produit populaire<br>• Disponible"},
  {"id": 11, "name": "Produit 11", "price": 10000, "stock": 4, "images": ["p11-1.jpeg", "p11-2.jpeg", "p11-3.jpeg"], "description": "• Bonne qualité<br>• Livraison rapide"},
  {"id": 12, "name": "Produit 12", "price": 10500, "stock": 6, "images": ["p12-1.jpeg", "p12-2.jpeg", "p12-3.jpeg"], "description": "• Produit original<br>• Disponible"},
  {"id": 13, "name": "Produit 13", "price": 11000, "stock": 8, "images": ["p13-1.jpeg", "p13-2.jpeg", "p13-3.jpeg"], "description": "• Très demandé<br>• Haute qualité"},
  {"id": 14, "name": "Produit 14", "price": 11500, "stock": 10, "images": ["p14-1.jpeg", "p14-2.jpeg", "p14-3.jpeg"], "description": "• Design élégant<br>• Livraison possible"},
  {"id": 15, "name": "Produit 15", "price": 12000, "stock": 5, "images": ["p15-1.jpeg", "p15-2.jpeg", "p15-3.jpeg"], "description": "• Produit neuf<br>• Disponible maintenant"},
  {"id": 16, "name": "Produit 16", "price": 12500, "stock": 6, "images": ["p16-1.jpeg", "p16-2.jpeg", "p16-3.jpeg"], "description": "• Bonne finition<br>• Produit vérifié"},
  {"id": 17, "name": "Produit 17", "price": 13000, "stock": 7, "images": ["p17-1.jpeg", "p17-2.jpeg", "p17-3.jpeg"], "description": "• Qualité premium<br>• Disponible"},
  {"id": 18, "name": "Produit 18", "price": 13500, "stock": 8, "images": ["p18-1.jpeg", "p18-2.jpeg", "p18-3.jpeg"], "description": "• Livraison rapide<br>• Bon produit"},
  {"id": 19, "name": "Produit 19", "price": 14000, "stock": 9, "images": ["p19-1.jpeg", "p19-2.jpeg", "p19-3.jpeg"], "description": "• Très bonne qualité<br>• Disponible"},
  {"id": 20, "name": "Produit 20", "price": 14500, "stock": 10, "images": ["p20-1.jpeg", "p20-2.jpeg", "p20-3.jpeg"], "description": "• Produit tendance<br>• Livraison Sénégal"},
  {"id": 21, "name": "Produit 21", "price": 15000, "stock": 5, "images": ["p21-1.jpeg", "p21-2.jpeg", "p21-3.jpeg"], "description": "• Produit premium<br>• Disponible"},
  {"id": 22, "name": "Produit 22", "price": 15500, "stock": 6, "images": ["p22-1.jpeg", "p22-2.jpeg", "p22-3.jpeg"], "description": "• Design moderne<br>• Haute qualité"},
  {"id": 23, "name": "Produit 23", "price": 16000, "stock": 7, "images": ["p23-1.jpeg", "p23-2.jpeg", "p23-3.jpeg"], "description": "• Produit neuf<br>• Disponible"},
  {"id": 24, "name": "Produit 24", "price": 16500, "stock": 8, "images": ["p24-1.jpeg", "p24-2.jpeg", "p24-3.jpeg"], "description": "• Livraison rapide<br>• Produit vérifié"},
  {"id": 25, "name": "Produit 25", "price": 17000, "stock": 9, "images": ["p25-1.jpeg", "p25-2.jpeg", "p25-3.jpeg"], "description": "• Très populaire<br>• Disponible"},
  {"id": 26, "name": "Produit 26", "price": 17500, "stock": 10, "images": ["p26-1.jpeg", "p26-2.jpeg", "p26-3.jpeg"], "description": "• Bonne qualité<br>• Livraison Sénégal"},
  {"id": 27, "name": "Produit 27", "price": 18000, "stock": 5, "images": ["p27-1.jpeg", "p27-2.jpeg", "p27-3.jpeg"], "description": "• Produit premium<br>• Disponible maintenant"}
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
  res.send("Backend DJIBY SHOP fonctionne 🔥");
});

app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "HTML connecté au backend 🔥"
  });
});

app.get("/products", (req, res) => {
  const products = db.prepare(
    "SELECT * FROM products ORDER BY id DESC"
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
// CRÉER UN PRODUIT
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

const setup = new paydunya.Setup({

  masterKey: process.env.PAYDUNYA_MASTER_KEY,
  privateKey: process.env.PAYDUNYA_PRIVATE_KEY,
  publicKey: process.env.PAYDUNYA_PUBLIC_KEY,
  token: process.env.PAYDUNYA_TOKEN,

  mode: process.env.PAYDUNYA_MODE || "test"
});

const store = new paydunya.Store({

  name: "DJIBY SHOP",
  tagline: "Produits de qualité",
  phoneNumber: "33745098191",
  websiteURL: SITE_URL
});

// =====================================
// CRÉER UN PAIEMENT
// =====================================

app.post("/create-payment", async (req, res) => {

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
      INSERT INTO orders
      (
        product_id,
        customer,
        invoice_token,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
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
        INSERT INTO orders
        (product_id, customer, invoice_token, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
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
// CONFIRMATION DES PAIEMENTS PAYDUNYA
// =====================================

app.post("/ipn", async function(req, res) {

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

    // Éviter de traiter deux fois la même commande

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
// DÉMARRAGE DU SERVEUR
// =====================================

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {

  console.log(
    "Backend lancé sur le port " + PORT
  );
});