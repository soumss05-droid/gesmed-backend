-- CreateEnum
CREATE TYPE "TypeNotification" AS ENUM ('VALIDEE', 'MODIFIEE', 'SCINDEE', 'REJETEE_POUR_CORRECTION', 'RUPTURE_STOCK');

-- AlterEnum
ALTER TYPE "StatutRequisition" ADD VALUE 'REJETEE_POUR_CORRECTION';

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "etablissement_id" TEXT NOT NULL,
    "type" "TypeNotification" NOT NULL,
    "message" TEXT NOT NULL,
    "requisition_id" TEXT,
    "produit_id" TEXT,
    "lue" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_etablissement_id_fkey" FOREIGN KEY ("etablissement_id") REFERENCES "etablissements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_produit_id_fkey" FOREIGN KEY ("produit_id") REFERENCES "produits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
