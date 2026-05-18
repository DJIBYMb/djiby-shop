const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const paydunya = require("paydunya");

dotenv.config();

const app = express();

let stocks = {
  1: 5,
  2: 10,
  3: 8,
  4: 12,
  5: 6
};
app.use(cors());
app.use(express.json());

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
  websiteURL: process.env.SITE_URL
});

app.get("/", function(req, res){
  res.send("Backend DJIBY SHOP fonctionne 🔥");
});

app.get("/test", function(req, res){
  res.json({
    success: true,
    message: "HTML connecté au backend 🔥"
  });
});

app.post("/create-payment", async function(req, res){
  try{
    const { product, customer } = req.body;
    
    if(stocks[product.id] <= 0){

  return res.json({
    success: false,
    message: "Ce produit est indisponible"
  });

}
    if(!product || !customer){
      return res.json({
        success: false,
        message: "Produit ou client manquant"
      });
    }

    const invoice = new paydunya.CheckoutInvoice(setup, store);

    const details =
    `Client: ${customer.firstName} ${customer.lastName} | Email: ${customer.email} | Téléphone: ${customer.phone} | Adresse: ${customer.address}`;

    invoice.addItem(product.name, 1, product.price, product.price, details);

    invoice.totalAmount = product.price;

    invoice.returnURL = "https://djibymb.github.io/djiby-shop/success.html";
    invoice.callbackURL = "https://djibybackenddjiby.onrender.com/ipn";

    invoice.description =
    "Merci de commander chez DJIBY SHOP. Produits de qualité. Livraison disponible. WhatsApp : 33745098191";

    await invoice.create();

    stocks[product.id] = stocks[product.id] - 1;
    console.log("Nouvelle commande :", {
      product,
      customer,
      status: "en attente"
    });

    res.json({
      success: true,
      status: "en attente",
      payment_url: invoice.url
    });

  }catch(error){
    console.log("ERREUR PAYDUNYA COMPLETE :", error);

    res.json({
      success: false,
      message: error.message || "Erreur PayDunya"
    });
  }
});

app.post("/ipn", function(req, res){

  console.log("IPN PayDunya reçu :", req.body);

  const status = req.body.status;

  if(status === "completed" || status === "success"){

    console.log({
      status:"payé",
      data:req.body
    });

  }else{

    console.log({
      status:"échoué",
      data:req.body
    });

  }

  res.send("ROK");

});

const PORT = process.env.PORT || 8000;

app.listen(PORT, function(){
  console.log("Backend lancé sur http://localhost:" + PORT);
});