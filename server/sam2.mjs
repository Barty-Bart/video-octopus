// Object separation's models: Meta's SAM 2.1 in Hugging Face's format, which the object-separation skill loads with
// transformers (Sam2VideoModel / Sam2VideoProcessor, from_pretrained with local_files_only, so it never downloads by
// itself). Three sizes; Setup recommends one for this computer and the creator can pick another (Settings → Rendering
// → Object separation; "auto" = the recommended one). Where each comes from, whether it's downloaded and its Download
// are server/hfmodels.mjs's, shared with the Whisper models.
import { IS_MAC } from './util.mjs';
import { FAMILIES, downloaded, downloadState, startDownload, stopDownload } from './hfmodels.mjs';

// Speed: Meta's own figures for SAM 2.1 (frames a second on one GPU: tiny 91, base-plus 64, large 40), as the time
// against tiny's. Sizes, makers and licences come from Hugging Face (hfmodels.mjs sources()).
export const SAM2_MODELS = {
  tiny: { repo: FAMILIES.sam2.models.tiny.repo, speed: 'the fastest; edges a little rougher', for: 'computers without a GPU' },
  'base-plus': { repo: FAMILIES.sam2.models['base-plus'].repo, speed: 'about 1.4× tiny\'s time; clean edges', for: 'Apple Silicon and NVIDIA cards under 12 GB' },
  large: { repo: FAMILIES.sam2.models.large.repo, speed: 'about 2.3× tiny\'s time; the most exact', for: 'NVIDIA cards with 12 GB or more' },
};
export const SAM2_SIZES = Object.keys(SAM2_MODELS);

// The recommendation (the skill's own table): NVIDIA 12 GB+ → large, a smaller NVIDIA card or Apple Silicon →
// base-plus, no GPU → tiny (it works, but takes seconds a frame).
export function sam2Recommend({ device, vramGB, gpu } = {}) {
  if (device === 'cuda') {
    const v = Number(vramGB) || 0;
    return { size: v >= 12 ? 'large' : 'base-plus', slow: false, why: `${gpu || 'an NVIDIA card'}${v ? ` with ${Math.round(v)} GB` : ''}` };
  }
  if (device === 'mps') return { size: 'base-plus', slow: false, why: 'Apple Silicon' };
  return { size: 'tiny', slow: true, why: 'no GPU it can use (the CPU)' };
}

// The device from the hardware alone (before torch is installed, or for Settings): Apple Silicon, an NVIDIA card, the CPU.
export const sam2Machine = (mac = {}) => ({ device: IS_MAC && /apple/i.test(mac.chip || '') ? 'mps' : mac.gpu ? 'cuda' : 'cpu', vramGB: mac.vramGB, gpu: mac.gpu });

export const sam2Have = () => downloaded('sam2');
export const sam2Download = () => downloadState('sam2');
export const startSam2Download = (size) => startDownload('sam2', size);
export const stopSam2Download = () => stopDownload('sam2');
