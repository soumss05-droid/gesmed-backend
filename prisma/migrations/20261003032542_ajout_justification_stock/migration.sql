-- AlterTable
ALTER TABLE "stocks" ADD COLUMN     "derniere_maj_statut" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "justifications_stock" (
    "id" TEXT NOT NULL,
    "produit_id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "statut" "StatutStock" NOT NULL,
    "texte" TEXT NOT NULL,
    "utilisateur_id" TEXT NOT NULL,
    "date_creation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "justifications_stock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "justifications_stock_produit_id_etablissement_id_idx" ON "justifications_stock"("produit_id", "etablissement_id");

-- AddForeignKey
ALTER TABLE "justifications_stock" ADD CONSTRAINT "justifications_stock_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "justifications_stock" ADD CONSTRAINT "justifications_stock_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "justifications_stock" ADD CONSTRAINT "justifications_stock_utilisateur_id_fkey" FOREIGN KEY ("utilisateur_id") REFERENCES "utilisateurs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
