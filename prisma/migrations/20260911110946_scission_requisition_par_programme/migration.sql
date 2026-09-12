-- AlterEnum
ALTER TYPE "StatutRequisition" ADD VALUE 'SCINDEE';

-- AlterTable
ALTER TABLE "requisitions" ADD COLUMN     "requisition_parent_id" TEXT;

-- AddForeignKey
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_requisition_parent_id_fkey" FOREIGN KEY ("requisition_parent_id") REFERENCES "requisitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
