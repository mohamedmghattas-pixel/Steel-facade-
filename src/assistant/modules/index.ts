/**
 * Registry of feature tool modules. Add one import + one entry per module;
 * keep this file to that list only.
 */
import type { ToolModule } from './types';
import { connectionsModule } from './connections';

export const TOOL_MODULES: ToolModule[] = [connectionsModule];
