const express = require("express");
const { authentifier } = require("../middleware/auth");
const { listerStocks } = require("../controllers/stocks.controller");

const router = express.Router();

router.get("/", authentifier, listerStocks);

module.exports = router;
