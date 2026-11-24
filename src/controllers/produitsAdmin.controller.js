const prisma = require("../config/prisma");

// Gestion des produits par l'administrateur : lister, modifier, supprimer (si jamais utilisé).

const RELATIONS_UTILISATION = {
  lots: "lot(s)",
  stocks: "stock(s)",
  requisitionLignes: "ligne(s) de commande",
  blLignes: "ligne(s) de bon de livraison",
  notifications: "notification(s)",
  dispensations: "dispensation(s)",
  pertesTransit: "perte(s) en transit",
  justificationsStock: "justification(s) de stock",
};

function texteOuNull(valeur) {
  if (valeur === undefined) return undefined;
  if (valeur === null) return null;
  const t = String(valeur).trim();
  return t === "" ? null : t;
}

function compterUtilisations(produit) {
  const detail = {};
  let total = 0;
  for (const cle of Object.keys(RELATIONS_UTILISATION)) {
    const n = produit._count ? produit._count[cle] : 0;
    if (n > 0) detail[cle] = n;
    total += n;
  }
  return { total, detail };
}

// GET /admin/produits
async function listerProduits(req, res) {
  try {
    const produits = await prisma.produit.findMany({
      include: {
        programme: { select: { id: true, nom: true } },
        _count: { select: Object.fromEntries(Object.keys(RELATIONS_UTILISATION).map((c) => [c, true])) },
      },
    });

    const liste = produits.map((p) => {
      const { total, detail } = compterUtilisations(p);
      return {
        id: p.id,
        nom: p.nom,
        forme: p.forme,
        unite: p.unite,
        categorie: p.categorie,
        seuilMinDefaut: p.seuilMinDefaut,
        seuilMaxDefaut: p.seuilMaxDefaut,
        programmeId: p.programmeId,
        programmeNom: p.programme ? p.programme.nom : null,
        utilisations: total,
        detailUtilisations: detail,
      };
    });

    liste.sort(
      (a, b) =>
        String(a.programmeNom).localeCompare(String(b.programmeNom), "fr") ||
        String(a.categorie || "").localeCompare(String(b.categorie || ""), "fr") ||
        String(a.nom).localeCompare(String(b.nom), "fr")
    );

    return res.json(liste);
  } catch (e) {
    console.error("listerProduits :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de la lecture des produits." });
  }
}

// PATCH /admin/produits/:id
// Body (tous facultatifs) : { nom, forme, unite, categorie, seuilMinDefaut, seuilMaxDefaut }
async function modifierProduit(req, res) {
  try {
    const { id } = req.params;
    const existant = await prisma.produit.findUnique({ where: { id } });
    if (!existant) return res.status(404).json({ erreur: "Produit introuvable." });

    const corps = req.body || {};
    const data = {};

    if (corps.nom !== undefined) {
      const nom = texteOuNull(corps.nom);
      if (!nom) return res.status(400).json({ erreur: "Le nom du produit est obligatoire." });
      if (nom.toLowerCase() !== existant.nom.trim().toLowerCase()) {
        const memeProgramme = await prisma.produit.findMany({
          where: { programmeId: existant.programmeId, NOT: { id } },
          select: { nom: true },
        });
        if (memeProgramme.some((p) => p.nom.trim().toLowerCase() === nom.toLowerCase())) {
          return res.status(409).json({ erreur: "Un produit portant ce nom existe déjà dans ce programme." });
        }
      }
      data.nom = nom;
    }

    for (const champ of ["forme", "unite", "categorie"]) {
      if (corps[champ] !== undefined) data[champ] = texteOuNull(corps[champ]);
    }

    const min = corps.seuilMinDefaut !== undefined ? Number(corps.seuilMinDefaut) : existant.seuilMinDefaut;
    const max = corps.seuilMaxDefaut !== undefined ? Number(corps.seuilMaxDefaut) : existant.seuilMaxDefaut;
    if (corps.seuilMinDefaut !== undefined || corps.seuilMaxDefaut !== undefined) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0) {
        return res.status(400).json({ erreur: "Les seuils doivent être des nombres entiers positifs ou nuls." });
      }
      if (min > max) {
        return res.status(400).json({ erreur: "Le seuil minimum ne peut pas dépasser le seuil maximum." });
      }
      data.seuilMinDefaut = min;
      data.seuilMaxDefaut = max;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ erreur: "Aucune modification à enregistrer." });
    }

    const produit = await prisma.produit.update({ where: { id }, data });
    return res.json({ message: "Produit modifié.", produit });
  } catch (e) {
    console.error("modifierProduit :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de la modification du produit." });
  }
}

// DELETE /admin/produits/:id
// Refuse si le produit a deja servi (lots, stocks, commandes, dispensations...).
async function supprimerProduit(req, res) {
  try {
    const { id } = req.params;
    const produit = await prisma.produit.findUnique({
      where: { id },
      include: {
        _count: { select: Object.fromEntries(Object.keys(RELATIONS_UTILISATION).map((c) => [c, true])) },
      },
    });
    if (!produit) return res.status(404).json({ erreur: "Produit introuvable." });

    const { total, detail } = compterUtilisations(produit);
    if (total > 0) {
      const morceaux = Object.entries(detail).map(([cle, n]) => `${n} ${RELATIONS_UTILISATION[cle]}`);
      return res.status(409).json({
        erreur: `Suppression refusée : ce produit est déjà utilisé (${morceaux.join(", ")}).`,
        detailUtilisations: detail,
      });
    }

    await prisma.produit.delete({ where: { id } });
    return res.json({ message: `Produit supprimé : ${produit.nom}.` });
  } catch (e) {
    if (e && e.code === "P2003") {
      return res.status(409).json({ erreur: "Suppression refusée : ce produit est référencé ailleurs dans le système." });
    }
    console.error("supprimerProduit :", e);
    return res.status(500).json({ erreur: "Erreur serveur lors de la suppression du produit." });
  }
}

module.exports = { listerProduits, modifierProduit, supprimerProduit };