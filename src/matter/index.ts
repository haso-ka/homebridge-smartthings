import { matterRegistry } from './matterRegistry';
import { DishwasherAdapter } from './dishwasherAdapter';
import { RobotVacuumAdapter } from './robotVacuumAdapter';

matterRegistry.registerAdapter('RoboticVacuumCleaner', RobotVacuumAdapter);
matterRegistry.registerAdapter('Dishwasher', DishwasherAdapter);

export { matterRegistry } from './matterRegistry';
export { BaseMatterAdapter } from './baseMatterAdapter';
export * from './matterTypes';
export { RobotVacuumAdapter } from './robotVacuumAdapter';
export { DishwasherAdapter } from './dishwasherAdapter';