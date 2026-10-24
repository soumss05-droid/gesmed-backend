// Cree les comptes des DRS (role DIRECTEUR_DRS) a partir d'un fichier CSV local.
// 1) Essai a blanc : affiche ce qui serait cree, ne modifie rien.
// 2) Ne cree rien tant que vous ne tapez pas CREER a l'ecran.
// Les mots de passe provisoires sont ecrits uniquement dans un fichier local (jamais affiches).
try { require("dotenv").config(); } catch (e) { /* dotenv facultatif */ }

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const prisma = require("../src/config/prisma");
const { hashPassword } = require("../src/utils/hash");

const MOTS_IGNORES = ["drs", "dras", "wilaya", "region", "de", "du", "des", "d", "la"];

function nettoyer(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cle(s) {
  return nettoyer(s)
    .split(" ")
    .filter((m) => m && MOTS_IGNORES.indexOf(m) === -1)
    .join(" ");
}

function slug(s) {
  return cle(s).replace(/ /g, "-");
}

function motDePasseAleatoire() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let mdp = "";
  for (let i = 0; i < 8; i++) mdp += alphabet[crypto.randomInt(alphabet.length)];
  return mdp;
}

function lireCsv(fichier) {
  const texte = fs.readFileSync(fichier, "utf8").replace(/^\uFEFF/, "");
  const lignes = texte.split(/\r?\n/);
  const rows = [];
  let sep = null;
  lignes.forEach((l, i) => {
    if (l.trim() === "") return;
    if (!sep) sep = l.indexOf(";") !== -1 ? ";" : l.indexOf("\t") !== -1 ? "\t" : ",";
    const c = l.split(sep).map((x) => x.trim());
    if (["drs", "dras", "region", "wilaya"].indexOf(nettoyer(c[0])) !== -1) return; // en-tete
    rows.push({ ligne: i + 1, drs: c[0] || "", nom: c[1] || "", tel: c[2] || "" });
  });
  return rows;
}

function poserQuestion(texte) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(texte, (rep) => { rl.close(); resolve(rep); }));
}

async function main() {
  const fichier = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "..", "directeurs.csv");
  if (!fs.existsSync(fichier)) {
    console.log("Fichier introuvable : " + fichier);
    process.exit(1);
  }
  const lignes = lireCsv(fichier);
  if (lignes.length === 0) {
    console.log("Le fichier ne contient aucune ligne de DRS.");
    process.exit(1);
  }

  const toutesDrs = await prisma.drs.findMany({ where: { actif: true } });
  const identifiants = new Set(
    (await prisma.utilisateur.findMany({ select: { identifiant: true } })).map((u) => u.identifiant.toLowerCase())
  );

  const plan = [];
  const erreurs = [];
  const drsUtilisees = new Set();

  for (const l of lignes) {
    const etiquette = "Ligne " + l.ligne + " (" + l.drs + ")";
    if (!l.drs || !l.nom) {
      erreurs.push(etiquette + " : wilaya ou nom manquant.");
      continue;
    }
    const k = cle(l.drs);
    let candidates = toutesDrs.filter((d) => cle(d.nom) === k);
    let approx = false;
    if (candidates.length === 0 && k) {
      candidates = toutesDrs.filter((d) => cle(d.nom).indexOf(k) !== -1 || k.indexOf(cle(d.nom)) !== -1);
      approx = true;
    }
    if (candidates.length === 0) {
      erreurs.push(etiquette + " : aucune DRS reconnue.");
      continue;
    }
    if (candidates.length > 1) {
      erreurs.push(etiquette + " : plusieurs DRS possibles (" + candidates.map((d) => d.nom).join(", ") + ").");
      continue;
    }
    const drs = candidates[0];
    if (drsUtilisees.has(drs.id)) {
      erreurs.push(etiquette + " : cette DRS apparait deux fois dans le fichier.");
      continue;
    }
    drsUtilisees.add(drs.id);

    const dejaDir = await prisma.userEtablissement.count({
      where: { role: "DIRECTEUR_DRS", etablissement: { drsId: drs.id } },
    });
    if (dejaDir > 0) {
      erreurs.push(etiquette + " : la DRS \"" + drs.nom + "\" a deja un compte DRS.");
      continue;
    }

    const depots = await prisma.etablissement.findMany({ where: { type: "WILAYA", drsId: drs.id } });
    if (depots.length !== 1) {
      erreurs.push(etiquette + " : " + depots.length + " fiche(s) Wilaya pour \"" + drs.nom + "\" (attendu : 1).");
      continue;
    }
    const depot = depots[0];

    let zone = null;
    const liens = await prisma.userEtablissement.findMany({
      where: { etablissementId: depot.id, role: "GESTIONNAIRE_DRS" },
      include: { utilisateur: true },
    });
    for (const lien of liens) {
      const m = lien.utilisateur.identifiant.match(/^gas\.drs\.(.+)$/i);
      if (m) zone = m[1].toLowerCase();
    }
    if (!zone) zone = slug(drs.nom);

    const base = "directeur.drs." + zone;
    let identifiant = base;
    let n = 2;
    while (identifiants.has(identifiant.toLowerCase())) identifiant = base + n++;
    identifiants.add(identifiant.toLowerCase());

    plan.push({
      drs, depot, identifiant, nomComplet: l.nom, telephone: l.tel || null, approx,
      motDePasse: motDePasseAleatoire(),
    });
  }

  console.log("");
  console.log("=== ESSAI A BLANC : rien n'est cree ===");
  for (const p of plan) {
    console.log(
      "OK     | " + p.drs.nom + " | " + p.nomComplet + " | " + p.identifiant + " | rattache a : " + p.depot.nom +
        (p.approx ? "  (DRS reconnue approximativement : a verifier)" : "")
    );
  }
  for (const e of erreurs) console.log("ERREUR | " + e);
  console.log("");
  console.log(plan.length + " compte(s) pret(s), " + erreurs.length + " erreur(s).");
  console.log("DRS connues : " + toutesDrs.map((d) => d.nom).join(" ; "));

  if (erreurs.length > 0) {
    console.log("");
    console.log("Corrigez le fichier puis relancez : rien n'a ete cree.");
    return;
  }

  const rep = await poserQuestion("\nTapez CREER pour creer ces " + plan.length + " compte(s), ou Entree pour annuler : ");
  if (rep.trim() !== "CREER") {
    console.log("Annule : rien n'a ete cree.");
    return;
  }

  const sortie = [];
  for (const p of plan) {
    try {
      const hash = await hashPassword(p.motDePasse);
      await prisma.$transaction(async (tx) => {
        const u = await tx.utilisateur.create({
          data: {
            nomComplet: p.nomComplet,
            identifiant: p.identifiant,
            motDePasseHash: hash,
            telephone: p.telephone,
            estAdminSysteme: false,
          },
        });
        await tx.userEtablissement.create({
          data: { utilisateurId: u.id, etablissementId: p.depot.id, role: "DIRECTEUR_DRS" },
        });
      });
      sortie.push([p.drs.nom, p.nomComplet, p.identifiant, p.motDePasse, p.telephone || ""].join(";"));
      console.log("Cree : " + p.identifiant);
    } catch (e) {
      console.log("ECHEC pour " + p.identifiant + " : " + e.message);
    }
  }

  if (sortie.length > 0) {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    const nom = "comptes-drs-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".csv";
    const chemin = path.join(__dirname, "..", "..", nom);
    fs.writeFileSync(chemin, "\uFEFF" + ["Wilaya;DRS;Identifiant;Mot de passe provisoire;Telephone"].concat(sortie).join("\r\n") + "\r\n", "utf8");
    console.log("");
    console.log("Fichier des mots de passe provisoires : " + chemin);
    console.log("Il est confidentiel : remettez les mots de passe aux DRS, puis supprimez le fichier.");
  }
}

main()
  .catch((e) => {
    console.error("ERREUR :", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());