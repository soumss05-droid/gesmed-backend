-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "etablissement_auteur_id" TEXT;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_etablissement_auteur_id_fkey" FOREIGN KEY ("etablissement_auteur_id") REFERENCES "etablissements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
