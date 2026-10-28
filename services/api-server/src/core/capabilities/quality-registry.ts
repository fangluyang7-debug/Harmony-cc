import { PrismaService } from '../../persistence/prisma/prisma.service';
import { CapabilityQualityRegistry } from '../runtime/capability-quality-registry';
import { CropQualityEvaluator } from '../runtime/crop-quality-evaluator';

/** Built-in capabilities are composed here; applications can register additional evaluators. */
export function createCapabilityQualityRegistry(prisma?:PrismaService):CapabilityQualityRegistry {
  const registry=new CapabilityQualityRegistry(prisma);
  registry.register('image.crop.v1',new CropQualityEvaluator(prisma));
  return registry;
}
