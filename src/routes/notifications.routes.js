const express = require("express");
const { authentifier } = require("../middleware/auth");
const { listerNotifications, marquerLue } = require("../controllers/notifications.controller");

const router = express.Router();

router.get("/", authentifier, listerNotifications);
router.post("/:id/lue", authentifier, marquerLue);

module.exports = router;