const express = require("express");
const { authentifier } = require("../middleware/auth");
const { tableauDeBord, produitsEnRupture } = require("../controllers/rapports.controller");

const router = express.Router();

router.get("/tableau-de-bord", authentifier, tableauDeBord);
router.get("/produits-en-rupture", authentifier, produitsEnRupture);

module.exports = router;
