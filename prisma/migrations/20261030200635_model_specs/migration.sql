-- AlterTable
ALTER TABLE "product_model" ADD COLUMN     "materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sizes_cm" DECIMAL(7,2)[] DEFAULT ARRAY[]::DECIMAL(7,2)[],
ADD COLUMN     "volume_ml" INTEGER;
