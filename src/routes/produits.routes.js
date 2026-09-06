const express = require("express");
const { authentifier } = require("../middleware/auth");
const { listerProduits } = require("../controllers/produits.controller");

const router = express.Router();

router.get("/", authentifier, listerProduits);

module.exports = router;
