const prisma = require("../config/prisma");

// ---------------------------------------------------------------------------
// Configuration de l'offre de service (cibles, éligibilité, ajout de services
// et de programmes).
//
//   GET  /offre-service-config/configuration
//   POST /offre-service-config/services                          { programmeCode, groupe?, nom, ciblePct? }
//   POST /offre-service-config/programmes                        { nom, code? }   (ADMIN seulement)
//   PUT  /offre-service-config/services/:serviceId               { ciblePct, actif }
//   GET  /offre-service-config/services/:serviceId/eligibilite
//   PUT  /offre-service-config/services/:serviceId/eligibilite   { etablissementIds }
//
// Qui peut configurer :
//   - ADMIN : tous les programmes (et seul à pouvoir créer un programme) ;
//   - GAS_PROGRAMME_NATIONAL : uniquement les services de SON programme ;
//   - tous les autres rôles : refusés.
// La cible et l'éligibilité ne sont jamais modifiables par la FOSA elle-même.
// Rien n'est jamais supprimé : un service ou un programme se désactive.
// ---------------------------------------------------------------------------

// Renvoie { programmeId } (null = tous les programmes) ou répond 403 et renvoie null.
async function perimetreConfig(req, res) {
  const { role, etablissementId } = req.utilisateur;

  if (role === "ADMIN") return { programmeId: null };

  if (role === "GAS_PROGRAMME_NATIONAL" && etablissementId) {
    const etab = await prisma.etablissement.findUnique({
      where: { id: etablissementId },
      select: { programmeId: true, actif: true },
    });
    if (etab && etab.actif && etab.programmeId) return { programmeId: etab.programmeId };
    res.status(403).json({ erreur: "Ton compte n'est rattaché à aucun programme." });
    return null;
  }

  res.status(403).json({ erreur: "Seuls l'administrateur et le programme national peuvent configurer l'offre de service." });
  return null;
}

// Charge le service demandé et vérifie qu'il est dans le périmètre de l'utilisateur.
async function serviceDansPerimetre(perimetre, serviceId, res) {
  const service = await prisma.serviceProgramme.findUnique({
    where: { id: serviceId },
    select: { id: true, nom: true, programmeId: true, ciblePct: true, actif: true },
  });
  if (!service) {
    res.status(404).json({ erreur: "Service introuvable." });
    return null;
  }
  if (perimetre.programmeId && service.programmeId !== perimetre.programmeId) {
    res.status(403).json({ erreur: "Ce service n'appartient pas à ton programme." });
    return null;
  }
  return service;
}

function nomDrs(etab) {
  return etab.drs?.nom || etab.moughataa?.drs?.nom || null;
}

// Transforme un texte en identifiant technique : "Vaccin rougeole" -> "VACCIN_ROUGEOLE".
function fabriquerCode(texte) {
  return String(texte)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Nettoie un texte saisi : espaces superflus retirés. Renvoie "" si ce n'est pas du texte.
function nettoyerTexte(valeur) {
  return typeof valeur === "string" ? valeur.trim().replace(/\s+/g, " ") : "";
}

// GET /offre-service-config/configuration
async function configuration(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    const [services, programmesBase, comptesEligibles, nbFosa] = await Promise.all([
      prisma.serviceProgramme.findMany({
        where: perimetre.programmeId ? { programmeId: perimetre.programmeId } : {},
        orderBy: { ordre: "asc" },
        include: { programme: { select: { code: true, nom: true } } },
      }),
      // Tous les programmes actifs, même sans service (ex. un nouveau programme PEV).
      // Le programme technique "AUTRE" n'est montré que s'il a des services.
      prisma.programme.findMany({
        where: {
          actif: true,
          ...(perimetre.programmeId ? { id: perimetre.programmeId } : {}),
          OR: [{ code: { not: "AUTRE" } }, { servicesProgramme: { some: {} } }],
        },
        select: { code: true, nom: true },
        orderBy: { nom: "asc" },
      }),
      prisma.eligibiliteService.groupBy({ by: ["serviceId"], _count: { _all: true } }),
      prisma.etablissement.count({ where: { type: "FORMATION_SANITAIRE", actif: true } }),
    ]);

    const eligiblesParService = new Map(comptesEligibles.map((c) => [c.serviceId, c._count._all]));

    const programmes = [];
    for (const s of services) {
      let programme = programmes.find((p) => p.code === s.programme.code);
      if (!programme) {
        programme = { code: s.programme.code, nom: s.programme.nom, groupes: [] };
        programmes.push(programme);
      }
      const nomGroupe = s.groupe || s.programme.nom;
      let groupe = programme.groupes.find((g) => g.groupe === nomGroupe);
      if (!groupe) {
        groupe = { groupe: nomGroupe, services: [] };
        programme.groupes.push(groupe);
      }
      groupe.services.push({
        id: s.id,
        nom: s.nom,
        ciblePct: s.ciblePct,
        actif: s.actif,
        poids: s.poids,
        nbEligibles: eligiblesParService.get(s.id) || 0,
      });
    }

    // Programmes sans aucun service : ajoutés à la fin pour pouvoir y créer des services.
    for (const p of programmesBase) {
      if (!programmes.some((x) => x.code === p.code)) {
        programmes.push({ code: p.code, nom: p.nom, groupes: [] });
      }
    }

    return res.json({
      nbFosa,
      peutCreerProgramme: req.utilisateur.role === "ADMIN",
      programmes,
    });
  } catch (erreur) {
    console.error("Erreur lors de la lecture de la configuration de l'offre de service :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du chargement de la configuration." });
  }
}

// POST /offre-service-config/services
// Body : { programmeCode, groupe?: texte, nom: texte, ciblePct?: null | entier 0..100 }
async function creerService(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    const { programmeCode, groupe, nom, ciblePct } = req.body || {};

    if (typeof programmeCode !== "string" || !programmeCode) {
      return res.status(400).json({ erreur: "Le programme est obligatoire." });
    }

    const programme = await prisma.programme.findUnique({
      where: { code: programmeCode },
      select: { id: true, code: true, nom: true, actif: true },
    });
    if (!programme || !programme.actif) {
      return res.status(404).json({ erreur: "Programme introuvable." });
    }
    if (perimetre.programmeId && programme.id !== perimetre.programmeId) {
      return res.status(403).json({ erreur: "Tu ne peux ajouter un service que dans ton propre programme." });
    }

    const nomNet = nettoyerTexte(nom);
    if (nomNet.length < 2 || nomNet.length > 120) {
      return res.status(400).json({ erreur: "Le nom du service doit contenir entre 2 et 120 caractères." });
    }

    const groupeNet = nettoyerTexte(groupe);
    if (groupeNet.length > 80) {
      return res.status(400).json({ erreur: "Le nom du groupe ne doit pas dépasser 80 caractères." });
    }

    let cible = null;
    if (ciblePct !== undefined && ciblePct !== null && ciblePct !== "") {
      cible = Number(ciblePct);
      if (!Number.isInteger(cible) || cible < 0 || cible > 100) {
        return res.status(400).json({ erreur: "La cible doit être un nombre entier entre 0 et 100." });
      }
    }

    const doublon = await prisma.serviceProgramme.findFirst({
      where: { programmeId: programme.id, nom: { equals: nomNet, mode: "insensitive" } },
      select: { id: true },
    });
    if (doublon) {
      return res.status(409).json({ erreur: "Un service portant ce nom existe déjà dans ce programme." });
    }

    // Code technique unique : PROGRAMME_NOM-DU-SERVICE, avec un numéro si besoin.
    const racine = `${programme.code}_${fabriquerCode(nomNet) || "SERVICE"}`.slice(0, 60);
    let code = racine;
    for (let i = 2; i < 50; i++) {
      const existe = await prisma.serviceProgramme.findUnique({ where: { code }, select: { id: true } });
      if (!existe) break;
      code = `${racine}_${i}`;
    }

    const maxOrdre = await prisma.serviceProgramme.aggregate({
      where: { programmeId: programme.id },
      _max: { ordre: true },
    });

    const cree = await prisma.serviceProgramme.create({
      data: {
        programmeId: programme.id,
        groupe: groupeNet || null,
        nom: nomNet,
        code,
        ciblePct: cible,
        ordre: (maxOrdre._max.ordre ?? 0) + 1,
        actif: true,
      },
      select: { id: true, nom: true, groupe: true, ciblePct: true, actif: true },
    });

    console.log(`[OFFRE-CONFIG] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} : service créé "${cree.nom}" dans le programme ${programme.code}`);
    return res.status(201).json({
      message: "Service ajouté.",
      service: { ...cree, nbEligibles: 0, programmeCode: programme.code },
    });
  } catch (erreur) {
    if (erreur && erreur.code === "P2002") {
      return res.status(409).json({ erreur: "Ce service existe déjà. Réessaie." });
    }
    console.error("Erreur lors de la création d'un service :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la création du service." });
  }
}

// POST /offre-service-config/programmes   (ADMIN seulement)
// Body : { nom: texte, code?: texte (lettres MAJUSCULES, chiffres, _) }
async function creerProgramme(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    if (perimetre.programmeId) {
      return res.status(403).json({ erreur: "Seul l'administrateur peut créer un programme." });
    }

    const { nom, code } = req.body || {};

    const nomNet = nettoyerTexte(nom);
    if (nomNet.length < 2 || nomNet.length > 80) {
      return res.status(400).json({ erreur: "Le nom du programme doit contenir entre 2 et 80 caractères." });
    }

    const codeSaisi = nettoyerTexte(code);
    const codeFinal = codeSaisi ? fabriquerCode(codeSaisi) : fabriquerCode(nomNet).slice(0, 30);
    if (!/^[A-Z0-9_]{2,30}$/.test(codeFinal)) {
      return res.status(400).json({ erreur: "Le code du programme doit contenir 2 à 30 lettres, chiffres ou « _ »." });
    }

    const existeCode = await prisma.programme.findUnique({ where: { code: codeFinal }, select: { id: true } });
    if (existeCode) {
      return res.status(409).json({ erreur: `Le code « ${codeFinal} » est déjà utilisé par un autre programme.` });
    }

    const existeNom = await prisma.programme.findFirst({
      where: { nom: { equals: nomNet, mode: "insensitive" } },
      select: { id: true },
    });
    if (existeNom) {
      return res.status(409).json({ erreur: "Un programme portant ce nom existe déjà." });
    }

    const cree = await prisma.programme.create({
      data: { nom: nomNet, code: codeFinal, actif: true },
      select: { id: true, nom: true, code: true },
    });

    console.log(`[OFFRE-CONFIG] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} : programme créé "${cree.nom}" (${cree.code})`);
    return res.status(201).json({ message: "Programme ajouté.", programme: { code: cree.code, nom: cree.nom, groupes: [] } });
  } catch (erreur) {
    if (erreur && erreur.code === "P2002") {
      return res.status(409).json({ erreur: "Ce programme existe déjà." });
    }
    console.error("Erreur lors de la création d'un programme :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la création du programme." });
  }
}

// PUT /offre-service-config/services/:serviceId
// Body : { ciblePct: null | entier 0..100, actif?: true|false }
async function modifierService(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    const service = await serviceDansPerimetre(perimetre, req.params.serviceId, res);
    if (!service) return;

    const { ciblePct, actif, nom, groupe, poids } = req.body || {};
    const data = {};

    if (ciblePct !== undefined) {
      if (ciblePct === null || ciblePct === "") {
        data.ciblePct = null;
      } else {
        const valeur = Number(ciblePct);
        if (!Number.isInteger(valeur) || valeur < 0 || valeur > 100) {
          return res.status(400).json({ erreur: "La cible doit être un nombre entier entre 0 et 100." });
        }
        data.ciblePct = valeur;
      }
    }

    if (nom !== undefined) {
      const nomNet = nettoyerTexte(nom);
      if (nomNet.length < 2 || nomNet.length > 120) {
        return res.status(400).json({ erreur: "Le nom du service doit contenir entre 2 et 120 caractères." });
      }
      if (nomNet.toLowerCase() !== String(service.nom || "").toLowerCase()) {
        const courant = await prisma.serviceProgramme.findUnique({
          where: { id: service.id },
          select: { programmeId: true },
        });
        const doublon = await prisma.serviceProgramme.findFirst({
          where: {
            programmeId: courant.programmeId,
            id: { not: service.id },
            nom: { equals: nomNet, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (doublon) {
          return res.status(409).json({ erreur: "Un service portant ce nom existe déjà dans ce programme." });
        }
      }
      data.nom = nomNet;
    }

    if (groupe !== undefined) {
      const groupeNet = nettoyerTexte(groupe);
      if (groupeNet.length > 80) {
        return res.status(400).json({ erreur: "Le nom du groupe ne doit pas dépasser 80 caractères." });
      }
      data.groupe = groupeNet || null;
    }

    if (poids !== undefined) {
      const valeurPoids = Number(poids);
      if (poids === null || poids === "" || !Number.isInteger(valeurPoids) || valeurPoids < 1 || valeurPoids > 5) {
        return res.status(400).json({ erreur: "Le poids doit \u00eatre un nombre entier entre 1 et 5." });
      }
      data.poids = valeurPoids;
    }

    if (actif !== undefined) {
      if (typeof actif !== "boolean") {
        return res.status(400).json({ erreur: "La valeur « actif » doit être oui ou non." });
      }
      data.actif = actif;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ erreur: "Aucune modification demandée." });
    }

    const misAJour = await prisma.serviceProgramme.update({
      where: { id: service.id },
      data,
      select: { id: true, nom: true, groupe: true, ciblePct: true, poids: true, actif: true },
    });

    console.log(`[OFFRE-CONFIG] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} : service "${service.nom}" → ${JSON.stringify(data)}`);
    return res.json({ message: "Service mis à jour.", service: misAJour });
  } catch (erreur) {
    console.error("Erreur lors de la mise à jour d'un service :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de la mise à jour du service." });
  }
}

// GET /offre-service-config/services/:serviceId/eligibilite
async function lireEligibilite(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    const service = await serviceDansPerimetre(perimetre, req.params.serviceId, res);
    if (!service) return;

    const [fosas, eligibles] = await Promise.all([
      prisma.etablissement.findMany({
        where: { type: "FORMATION_SANITAIRE", actif: true },
        select: {
          id: true,
          nom: true,
          niveau: true,
          drs: { select: { nom: true } },
          moughataa: { select: { nom: true, drs: { select: { nom: true } } } },
        },
      }),
      prisma.eligibiliteService.findMany({
        where: { serviceId: service.id },
        select: { etablissementId: true },
      }),
    ]);

    const ids = new Set(eligibles.map((e) => e.etablissementId));

    const lignes = fosas
      .map((f) => ({
        id: f.id,
        nom: f.nom,
        drs: nomDrs(f),
        moughataa: f.moughataa?.nom || null,
        niveau: f.niveau || null,
        eligible: ids.has(f.id),
      }))
      .sort(
        (a, b) =>
          (a.drs || "").localeCompare(b.drs || "", "fr") ||
          (a.moughataa || "").localeCompare(b.moughataa || "", "fr") ||
          a.nom.localeCompare(b.nom, "fr")
      );

    return res.json({ service: { id: service.id, nom: service.nom }, fosas: lignes });
  } catch (erreur) {
    console.error("Erreur lors de la lecture de l'éligibilité :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors du chargement de l'éligibilité." });
  }
}

// PUT /offre-service-config/services/:serviceId/eligibilite
// Body : { etablissementIds: [id, ...] }  — remplace la liste complète.
// Liste vide = aucune FOSA marquée (les deux dénominateurs sont alors identiques).
async function enregistrerEligibilite(req, res) {
  try {
    const perimetre = await perimetreConfig(req, res);
    if (!perimetre) return;

    const service = await serviceDansPerimetre(perimetre, req.params.serviceId, res);
    if (!service) return;

    const { etablissementIds } = req.body || {};
    if (!Array.isArray(etablissementIds) || etablissementIds.length > 3000 || etablissementIds.some((i) => typeof i !== "string")) {
      return res.status(400).json({ erreur: "Liste de formations sanitaires invalide." });
    }

    const ids = [...new Set(etablissementIds)];

    if (ids.length > 0) {
      const valides = await prisma.etablissement.count({
        where: { id: { in: ids }, type: "FORMATION_SANITAIRE", actif: true },
      });
      if (valides !== ids.length) {
        return res.status(400).json({ erreur: "Une des formations sanitaires choisies n'existe pas ou n'est plus active." });
      }
    }

    await prisma.$transaction([
      prisma.eligibiliteService.deleteMany({ where: { serviceId: service.id } }),
      ...(ids.length > 0
        ? [
            prisma.eligibiliteService.createMany({
              data: ids.map((etablissementId) => ({ serviceId: service.id, etablissementId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    console.log(`[OFFRE-CONFIG] ${new Date().toISOString()} — utilisateur ${req.utilisateur.utilisateurId} : éligibilité de "${service.nom}" → ${ids.length} FOSA`);
    return res.json({ message: "Éligibilité enregistrée.", nbEligibles: ids.length });
  } catch (erreur) {
    console.error("Erreur lors de l'enregistrement de l'éligibilité :", erreur);
    return res.status(500).json({ erreur: "Erreur serveur lors de l'enregistrement de l'éligibilité." });
  }
}

module.exports = {
  configuration,
  creerService,
  creerProgramme,
  modifierService,
  lireEligibilite,
  enregistrerEligibilite,
};