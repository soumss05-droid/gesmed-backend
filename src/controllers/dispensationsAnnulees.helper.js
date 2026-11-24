const prisma = require("../config/prisma");

// Identifiants des dispensations annulees (statut ANNULEE).
// Les calculs de consommation ignorent les mouvements de ces dispensations.
async function idsDispensationsAnnulees() {
  const lignes = await prisma.dispensation.findMany({ where: { statut: "ANNULEE" }, select: { id: true } });
  return lignes.map((l) => l.id);
}

module.exports = { idsDispensationsAnnulees };
