-- AlterTable
ALTER TABLE "product_model" ADD COLUMN     "gsm" INTEGER,
ADD COLUMN     "print_techniques" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sheets" INTEGER;
