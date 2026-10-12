const prisma = require("../config/prisma");

// ---------------------------------------------------------------------------
// Vue administrateur : ce que les GAS DRS ont créé via « Mon équipe ».
// Lecture seule + marquage « vu ». Aucune suppression.
// ---------------------------------------------------------------------------

// GET /journal-equipe?nonLusSeulement=true
async function listerJournal(req, res) {
  const nonLusSeulement = req.query.nonLusSeulement === "true";
  const where = nonLusSeulement ? { lu: false } : {};
  const [entrees, nonLus] = await Promise.all([
    prisma.journalEquipe.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.journalEquipe.count({ where: { lu: false } }),
  ]);
  return res.json({ nonLus, entrees });
}

// POST /journal-equipe/:id/lu
async function marquerVu(req, res) {
  const { id } = req.params;
  const entree = await prisma.journalEquipe.findUnique({ where: { id }, select: { id: true } });
  if (!entree) return res.status(404).json({ erreur: "Entrée introuvable." });
  await prisma.journalEquipe.update({ where: { id }, data: { lu: true } });
  return res.json({ ok: true });
}

// POST /journal-equipe/tout-lu
async function toutMarquerVu(req, res) {
  const r = await prisma.journalEquipe.updateMany({ where: { lu: false }, data: { lu: true } });
  return res.json({ ok: true, marquees: r.count });
}

module.exports = { listerJournal, marquerVu, toutMarquerVu };