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

export const TOOL_MODULES: ToolModule[] = [fabricationModule, movementModule, modellingModule, drawingsModule, managementModule];
