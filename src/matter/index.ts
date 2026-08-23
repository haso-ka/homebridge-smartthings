import { matterRegistry } from './matterRegistry';
import { RobotVacuumAdapter } from './robotVacuumAdapter';

matterRegistry.registerAdapter('RoboticVacuumCleaner', RobotVacuumAdapter);

export { matterRegistry } from './matterRegistry';
export { BaseMatterAdapter } from './baseMatterAdapter';
export * from './matterTypes';
export { RobotVacuumAdapter } from './robotVacuumAdapter';