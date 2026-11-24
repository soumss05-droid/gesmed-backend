const prisma = require("../config/prisma");
const { recalculerStatutStock } = require("./stocks.controller");

function erreurMetier(message) {
  const e = new Error(message);
  e.metier = true;
  return e;
}

// POST /stocks/dispensation/panier
// Corps : { lignes: [{ produitId, quantite }], typeBeneficiaire, beneficiaire }
// Enregistre une dispensation par produit (meme beneficiaire), toutes ensemble ou aucune.
// Memes regles que la dispensation simple : lots FEFO, marge selon le niveau, prix fige.
async function enregistrerDispensationPanier(req, res) {
  try {
    const { etablissementId, utilisateurId, role } = req.utilisateur;
    if (role !== "FORMATION_SANITAIRE") {
      return res.status(403).json({ erreur: "Seule une formation sanitaire peut enregistrer une dispensation." });
    }

    const { lignes, typeBeneficiaire, beneficiaire } = req.body || {};

    const typesValides = ["PATIENT", "LABORATOIRE", "MATERNITE", "SERVICE"];
    if (!typeBeneficiaire || !typesValides.includes(typeBeneficiaire)) {
      return res.status(400).json({ erreur: "Type de bénéficiaire requis et invalide." });
    }
    if (!beneficiaire || !String(beneficiaire).trim()) {
      return res.status(400).json({ erreur: "Le nom, téléphone ou code du bénéficiaire est requis." });
    }
    if (!Array.isArray(lignes) || lignes.length === 0) {
      return res.status(400).json({ erreur: "Le panier est vide." });
    }
    if (lignes.length > 50) {
      return res.status(400).json({ erreur: "Le panier est limité à 50 lignes." });
    }

    // Fusion des doublons : un meme produit saisi deux fois est additionne.
    const parProduit = new Map();
    for (const l of lignes) {
      const q = Number(l && l.quantite);
      if (!l || !l.produitId || !Number.isFinite(q) || q <= 0) {
        return res.status(400).json({ erreur: "Chaque ligne doit avoir un produit et une quantité valide." });
      }
      const cle = String(l.produitId);
      if (parProduit.has(cle)) parProduit.get(cle).quantite += q;
      else parProduit.set(cle, { produitId: l.produitId, quantite: q });
    }
    const lignesFusionnees = Array.from(parProduit.values());

    const produits = await prisma.produit.findMany({
      where: { id: { in: lignesFusionnees.map((l) => l.produitId) } },
      select: { id: true, nom: true },
    });
    const nomParProduit = new Map(produits.map((p) => [String(p.id), p.nom]));
    for (const l of lignesFusionnees) {
      if (!nomParProduit.has(String(l.produitId))) {
        return res.status(400).json({ erreur: "Un produit du panier est introuvable." });
      }
    }

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

    const creees = await prisma.$transaction(
      async (tx) => {
        const resultat = [];
        for (const ligne of lignesFusionnees) {
          const { produitId, quantite } = ligne;
          const nomProduit = nomParProduit.get(String(produitId));

          const lots = await tx.lot.findMany({
            where: { produitId, etablissementId, quantite: { gt: 0 } },
            orderBy: { datePeremption: "asc" },
          });

          const lotsChoisis = [];
          let restant = quantite;
          for (const lot of lots) {
            if (restant <= 0) break;
            const prise = Math.min(lot.quantite, restant);
            lotsChoisis.push({ lotId: lot.id, quantite: prise, prixUnitaire: lot.prixUnitaire });
            restant -= prise;
          }
          if (restant > 0) {
            throw erreurMetier(`Stock insuffisant pour « ${nomProduit} » : ${restant} unité(s) manquante(s). Rien n'a été enregistré.`);
          }

          let coutTotal = 0;
          let prixInconnu = false;
          for (const lc of lotsChoisis) {
            if (lc.prixUnitaire === null || lc.prixUnitaire === undefined) prixInconnu = true;
            else coutTotal += lc.quantite * Number(lc.prixUnitaire);
          }
          const montantFige = prixInconnu ? null : Math.round(coutTotal * (1 + margeValeur / 100) * 100) / 100;
          const prixUnitaireFige = montantFige === null ? null : Math.round((montantFige / quantite) * 100) / 100;

          const dispensation = await tx.dispensation.create({
            data: {
              montantTotal: montantFige,
              prixUnitaire: prixUnitaireFige,
              margePourcent: montantFige === null ? null : margeValeur,
              etablissementId,
              produitId,
              quantite,
              typeBeneficiaire,
              beneficiaire: String(beneficiaire).trim(),
              utilisateurId,
            },
          });

          for (const lc of lotsChoisis) {
            await tx.lot.update({ where: { id: lc.lotId }, data: { quantite: { decrement: lc.quantite } } });
            await tx.mouvementStock.create({
              data: {
                lotId: lc.lotId,
                type: "SORTIE",
                quantite: lc.quantite,
                referenceType: "DISPENSATION",
                referenceId: dispensation.id,
                utilisateurId,
              },
            });
          }

          await tx.stock.update({
            where: { produitId_etablissementId: { produitId, etablissementId } },
            data: { quantiteTotale: { decrement: quantite } },
          });

          resultat.push({ ...dispensation, nomProduit, prixUnitaireMoyen: dispensation.prixUnitaire });
        }
        return resultat;
      },
      { timeout: 30000, maxWait: 10000 }
    );

    // Statuts de stock recalcules apres l'enregistrement.
    for (const l of lignesFusionnees) {
      try {
        await recalculerStatutStock(l.produitId, etablissementId);
      } catch (e) {
        console.error("Recalcul du statut de stock impossible :", e.message);
      }
    }

    const sansPrix = creees.some((d) => d.montantTotal === null || d.montantTotal === undefined);
    const montantTotalPanier = sansPrix
      ? null
      : Math.round(creees.reduce((s, d) => s + Number(d.montantTotal), 0) * 100) / 100;

    return res.status(201).json({
      message: "Dispensation enregistrée.",
      dispensations: creees,
      montantTotalPanier,
    });
  } catch (e) {
    if (e && e.metier) return res.status(400).json({ erreur: e.message });
    console.error("Erreur dispensation panier :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de l'enregistrement de la dispensation." });
  }
}

module.exports = { enregistrerDispensationPanier };