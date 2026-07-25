import { bootCanvas } from './render/canvas';
import { startGame } from './game/loop';

const root = document.getElementById('app')!;
startGame(bootCanvas(root), root);
