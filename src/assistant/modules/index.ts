/**
 * Registry of feature tool modules. Add one import + one entry per module;
 * keep this file to that list only.
 */
import type { ToolModule } from './types';
import { fabricationModule } from './fabrication';
import { movementModule } from './movement';
import { modellingModule } from './modelling';
import { drawingsModule } from './drawings';
import { managementModule } from './management';
import { connectionsModule } from './connections';
import { wireframeModule } from './wireframe';
import { profilesModule } from './profiles';
import { exportPackageModule } from './exportPackage';

export const TOOL_MODULES: ToolModule[] = [fabricationModule, movementModule, modellingModule, drawingsModule, managementModule, connectionsModule, wireframeModule, profilesModule, exportPackageModule];
