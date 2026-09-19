const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  tableauDeBord,
  produitsEnRupture,
  evolutionMouvements,
  requisitionsKanban,
} = require("../controllers/rapports.controller");

const router = express.Router();

router.get("/tableau-de-bord", authentifier, tableauDeBord);
router.get("/produits-en-rupture", authentifier, produitsEnRupture);
router.get("/evolution-mouvements", authentifier, evolutionMouvements);
router.get("/requisitions-kanban", authentifier, requisitionsKanban);

module.exports = router;