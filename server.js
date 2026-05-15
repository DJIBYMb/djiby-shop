const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const paydunya = require("paydunya");

dotenv.config();

const app = express();
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

app.get("/test", function(req,res){
  res.json({success:true,message:"HTML connecté au backend 🔥"});
});

app.post("/create-payment", async function(req,res){
  try{
    const { product, customer } = req.body;

    if(!product || !customer){
      return res.json({success:false,message:"Produit ou client manquant"});
    }

    const invoice = new paydunya.CheckoutInvoice(setup, store);

    const details =
    `Client: ${customer.firstName} ${customer.lastName} | Email: ${customer.email} | Téléphone: ${customer.phone} | Adresse: ${customer.address}`;

    invoice.addItem(product.name,1,product.price,product.price,details);
    invoice.totalAmount = product.price;

    await invoice.create();

    console.log("Nouvelle commande :", {product, customer});

    res.json({
      success:true,
      payment_url:invoice.url
    });

  }catch(error){
    console.log(error);
    res.json({
      success:false,
      message:error.message || "Erreur PayDunya"
    });
  }
});
app.get("/", function(req,res){
  res.send("Backend DJIBY SHOP fonctionne 🔥");
});

app.get("/test", function(req,res){
  res.json({
    success:true,
    message:"HTML connecté au backend 🔥"
  });
});

const API_URL = "https://TON-BACKEND.onrender.com";

app.listen(PORT, function(){
  console.log("Backend lancé sur le port " + PORT);

});