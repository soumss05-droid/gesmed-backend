-- AlterTable
ALTER TABLE "lignes_inventaire" ADD COLUMN     "ecart_decideur_id" TEXT,
ADD COLUMN     "ecart_motif" TEXT,
ADD COLUMN     "ecart_statut" "EcartStatut";

-- AddForeignKey
ALTER TABLE "lignes_inventaire" ADD CONSTRAINT "lignes_inventaire_ecart_decideur_id_fkey" FOREIGN KEY ("ecart_decideur_id") REFERENCES "utilisateurs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
