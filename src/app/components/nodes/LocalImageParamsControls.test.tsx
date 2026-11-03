import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalImageParamsControls } from './LocalImageParamsControls';

it('renders actual model-specific controls without mixing LoRAs', () => {
  const klein = renderToStaticMarkup(<LocalImageParamsControls kind="klein" zh onChange={() => {}} />);
  expect(klein).toContain('0–4');
  expect(klein).toContain('FLUX CFG');
  expect(klein).not.toContain('Krea LoRA');
  const krea = renderToStaticMarkup(<LocalImageParamsControls kind="krea2" zh value={{ lora: 'darkbrush', loraStrength: 0.7 }} onChange={() => {}} />);
  expect(krea).toContain('Krea LoRA strength');
  expect(krea).toContain('Darkbrush');
  expect(krea).not.toContain('FLUX CFG');
});
