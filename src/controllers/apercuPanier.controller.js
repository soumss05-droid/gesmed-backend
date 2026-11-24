const prisma = require("../config/prisma");

// POST /stocks/dispensation/panier/apercu
// Corps : { lignes: [{ produitId, quantite }] }
// Calcule le montant de chaque ligne du panier sans rien enregistrer, avec les memes regles
// que l'enregistrement : lots FEFO, marge selon le niveau de la formation sanitaire.
async function apercuPanier(req, res) {
  try {
    const { etablissementId, role } = req.utilisateur;
    if (role !== "FORMATION_SANITAIRE") {
      return res.status(403).json({ erreur: "Réservé aux formations sanitaires." });
    }

    const lignes = req.body && req.body.lignes;
    if (!Array.isArray(lignes) || lignes.length === 0) {
      return res.json({ lignes: [], montantTotalPanier: 0 });
    }
    if (lignes.length > 50) {
      return res.status(400).json({ erreur: "Le panier est limité à 50 lignes." });
    }

    const parProduit = new Map();
    for (const l of lignes) {
      const q = Number(l && l.quantite);
      if (!l || !l.produitId || !Number.isFinite(q) || q <= 0) continue;
      const cle = String(l.produitId);
      if (parProduit.has(cle)) parProduit.get(cle).quantite += q;
      else parProduit.set(cle, { produitId: l.produitId, quantite: q });
    }
    const items = Array.from(parProduit.values());
    if (items.length === 0) return res.json({ lignes: [], montantTotalPanier: 0 });

    // Marge selon le niveau de la formation sanitaire (puis marge par defaut, puis 0).
    const etab = await prisma.etablissement.findUnique({ where: { id: etablissementId }, select: { niveau: true } });
    const clesMarge = [];
    if (etab && etab.niveau) clesMarge.push("marge_" + etab.niveau);
    clesMarge.push("marge_pourcent");
    const paramsMarge = await prisma.parametreSysteme.findMany({ where: { cle: { in: clesMarge } } });
    let margeValeur = null;
    for (const cle of clesMarge) {
      const p = paramsMarge.find((x) => x.cle === cle);
      if (!p || String(p.valeur).trim() === "") continue;
      const n = Number(p.valeur);
      if (Number.isFinite(n) && n >= 0) {
        margeValeur = n;
        break;
      }
    }
    if (margeValeur === null) margeValeur = 0;

    const lots = await prisma.lot.findMany({
      where: { produitId: { in: items.map((i) => i.produitId) }, etablissementId, quantite: { gt: 0 } },
      orderBy: { datePeremption: "asc" },
    });
    const lotsParProduit = new Map();
    for (const lot of lots) {
      const cle = String(lot.produitId);
      if (!lotsParProduit.has(cle)) lotsParProduit.set(cle, []);
      lotsParProduit.get(cle).push(lot);
    }

    let total = 0;
    const resultat = items.map((item) => {
      const lotsProduit = lotsParProduit.get(String(item.produitId)) || [];
      const stockDisponible = lotsProduit.reduce((s, l) => s + l.quantite, 0);

      let restant = item.quantite;
      let cout = 0;
      let prixInconnu = false;
      for (const lot of lotsProduit) {
        if (restant <= 0) break;
        const prise = Math.min(lot.quantite, restant);
        if (lot.prixUnitaire === null || lot.prixUnitaire === undefined) prixInconnu = true;
        else cout += prise * Number(lot.prixUnitaire);
        restant -= prise;
      }

      const suffisant = restant <= 0;
      const montantTotal = suffisant && !prixInconnu ? Math.round(cout * (1 + margeValeur / 100) * 100) / 100 : null;
      const prixUnitaire = montantTotal === null ? null : Math.round((montantTotal / item.quantite) * 100) / 100;
      if (montantTotal !== null) total += montantTotal;

      return { produitId: item.produitId, quantite: item.quantite, stockDisponible, suffisant, montantTotal, prixUnitaire };
    });

    return res.json({ lignes: resultat, montantTotalPanier: Math.round(total * 100) / 100 });
  } catch (e) {
    console.error("Erreur apercu du panier :", e);
    return res.status(500).json({ erreur: "Erreur serveur." });
  }
}

module.exports = { apercuPanier };
