-- CreateEnum
CREATE TYPE "TypeEtablissement" AS ENUM ('CAMEC', 'GAS_PROGRAMME_NATIONAL', 'GAS_DRS', 'GAS_MOUGHATAA', 'FORMATION_SANITAIRE');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CAMEC', 'GESTIONNAIRE_DRS', 'DIRECTEUR_DRS', 'GAS_MOUGHATAA', 'GAS_PROGRAMME_NATIONAL', 'FORMATION_SANITAIRE', 'AUDITEUR', 'ADMIN');

-- CreateEnum
CREATE TYPE "StatutStock" AS ENUM ('RUPTURE', 'SOUS_SEUIL', 'NORMAL', 'SURSTOCK');

-- CreateEnum
CREATE TYPE "TypeMouvement" AS ENUM ('ENTREE', 'SORTIE', 'AJUSTEMENT', 'BLOCAGE_ECART', 'DEBLOCAGE_ECART');

-- CreateEnum
CREATE TYPE "ReferenceType" AS ENUM ('REQUISITION', 'BL', 'MANUEL');

-- CreateEnum
CREATE TYPE "StatutRequisition" AS ENUM ('BROUILLON', 'EN_ATTENTE', 'MODIFIEE_EN_ATTENTE_CONFIRMATION', 'VALIDEE', 'REJETEE', 'EXPEDIEE', 'CLOTUREE');

-- CreateEnum
CREATE TYPE "StatutBl" AS ENUM ('ENVOYE', 'RECU_SANS_ECART', 'RECU_AVEC_ECART_BLOQUE', 'RECU_AVEC_ECART_DEBLOQUE');

-- CreateEnum
CREATE TYPE "EcartStatut" AS ENUM ('EN_ATTENTE', 'DEBLOQUE', 'MAINTENU');

-- CreateTable
CREATE TABLE "drs" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "drs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moughataa" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "drs_id" TEXT NOT NULL,

    CONSTRAINT "moughataa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etablissements" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "type" "TypeEtablissement" NOT NULL,
    "a_stock_physique" BOOLEAN NOT NULL,
    "drs_id" TEXT,
    "moughataa_id" TEXT,
    "adresse" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "etablissements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utilisateurs" (
    "id" TEXT NOT NULL,
    "nom_complet" TEXT NOT NULL,
    "identifiant" TEXT NOT NULL,
    "mot_de_passe_hash" TEXT NOT NULL,
    "telephone" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utilisateurs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_etablissements" (
    "id" TEXT NOT NULL,
    "utilisateur_id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "date_debut" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_etablissements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produits" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "forme" TEXT,
    "unite" TEXT,
    "seuil_min_defaut" INTEGER NOT NULL,
    "seuil_max_defaut" INTEGER NOT NULL,

    CONSTRAINT "produits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "numero_lot" TEXT NOT NULL,
    "date_peremption" TIMESTAMP(3) NOT NULL,
    "quantite" INTEGER NOT NULL,
    "date_reception" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocks" (
    "id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "quantite_totale" INTEGER NOT NULL DEFAULT 0,
    "seuil_min" INTEGER NOT NULL,
    "seuil_max" INTEGER NOT NULL,
    "statut" "StatutStock" NOT NULL DEFAULT 'RUPTURE',

    CONSTRAINT "stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mouvements_stock" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "type" "TypeMouvement" NOT NULL,
    "quantite" INTEGER NOT NULL,
    "date_mouvement" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference_type" "ReferenceType",
    "reference_id" TEXT,
    "utilisateur_id" TEXT NOT NULL,

    CONSTRAINT "mouvements_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitions" (
    "id" TEXT NOT NULL,
    "etablissement_demandeur_id" TEXT NOT NULL,
    "niveau_actuel_id" TEXT NOT NULL,
    "statut" "StatutRequisition" NOT NULL DEFAULT 'BROUILLON',
    "date_creation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_derniere_maj" TIMESTAMP(3) NOT NULL,
    "justification" TEXT,

    CONSTRAINT "requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_lignes" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "quantite_demandee" INTEGER NOT NULL,
    "quantite_validee" INTEGER NOT NULL,

    CONSTRAINT "requisition_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bordereaux_livraison" (
    "id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "etablissement_expediteur_id" TEXT NOT NULL,
    "etablissement_destinataire_id" TEXT NOT NULL,
    "date_envoi" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_reception_confirmee" TIMESTAMP(3),
    "statut" "StatutBl" NOT NULL DEFAULT 'ENVOYE',

    CONSTRAINT "bordereaux_livraison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bl_lignes" (
    "id" TEXT NOT NULL,
    "bl_id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "quantite_envoyee" INTEGER NOT NULL,
    "quantite_recue" INTEGER,
    "ecart" INTEGER,
    "ecart_statut" "EcartStatut",
    "ecart_decideur_id" TEXT,
    "ecart_motif" TEXT,

    CONSTRAINT "bl_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drs_code_key" ON "drs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "utilisateurs_identifiant_key" ON "utilisateurs"("identifiant");

-- CreateIndex
CREATE UNIQUE INDEX "user_etablissements_utilisateur_id_etablissement_id_key" ON "user_etablissements"("utilisateur_id", "etablissement_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocks_produit_id_etablissement_id_key" ON "stocks"("produit_id", "etablissement_id");

-- AddForeignKey
ALTER TABLE "moughataa" ADD CONSTRAINT "moughataa_drs_id_fkey" FOREIGN KEY ("drs_id") REFERENCES "drs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etablissements" ADD CONSTRAINT "etablissements_drs_id_fkey" FOREIGN KEY ("drs_id") REFERENCES "drs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etablissements" ADD CONSTRAINT "etablissements_moughataa_id_fkey" FOREIGN KEY ("moughataa_id") REFERENCES "moughataa"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_etablissements" ADD CONSTRAINT "user_etablissements_utilisateur_id_fkey" FOREIGN KEY ("utilisateur_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_etablissements" ADD CONSTRAINT "user_etablissements_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocks" ADD CONSTRAINT "stocks_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mouvements_stock" ADD CONSTRAINT "mouvements_stock_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mouvements_stock" ADD CONSTRAINT "mouvements_stock_utilisateur_id_fkey" FOREIGN KEY ("utilisateur_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_etablissement_demandeur_id_fkey" FOREIGN KEY ("etablissement_demandeur_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_niveau_actuel_id_fkey" FOREIGN KEY ("niveau_actuel_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lignes" ADD CONSTRAINT "requisition_lignes_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_lignes" ADD CONSTRAINT "requisition_lignes_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bordereaux_livraison" ADD CONSTRAINT "bordereaux_livraison_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bordereaux_livraison" ADD CONSTRAINT "bordereaux_livraison_etablissement_expediteur_id_fkey" FOREIGN KEY ("etablissement_expediteur_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bordereaux_livraison" ADD CONSTRAINT "bordereaux_livraison_etablissement_destinataire_id_fkey" FOREIGN KEY ("etablissement_destinataire_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bl_lignes" ADD CONSTRAINT "bl_lignes_bl_id_fkey" FOREIGN KEY ("bl_id") REFERENCES "bordereaux_livraison"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bl_lignes" ADD CONSTRAINT "bl_lignes_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bl_lignes" ADD CONSTRAINT "bl_lignes_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bl_lignes" ADD CONSTRAINT "bl_lignes_ecart_decideur_id_fkey" FOREIGN KEY ("ecart_decideur_id") REFERENCES "utilisateurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
