const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="1000" height="1000"><rect width="400" height="400" fill="#fff"/><g fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;

const petals = Array.from({ length: 8 }, (_, i) =>
  `<path transform="rotate(${i * 45} 200 150)" d="M200 120C165 85 170 40 200 25C230 40 235 85 200 120Z"/>`).join('');

export const SAMPLES: { name: string; svg: string }[] = [
  {
    name: 'Flor',
    svg: wrap(`${petals}<circle cx="200" cy="150" r="30"/><path d="M200 182C195 250 205 310 195 380"/><path d="M198 290C160 250 120 255 95 275C130 305 170 305 198 290Z"/><path d="M200 330C240 290 280 295 305 315C270 345 230 345 200 330Z"/>`),
  },
  {
    name: 'Gato',
    svg: wrap(`<path d="M95 165L85 60L160 110C185 102 215 102 240 110L315 60L305 165C325 200 325 250 300 285C270 330 130 330 100 285C75 250 75 200 95 165Z"/><ellipse cx="155" cy="195" rx="18" ry="24"/><ellipse cx="245" cy="195" rx="18" ry="24"/><path d="M155 183V207M245 183V207"/><path d="M188 235H212L200 250Z"/><path d="M200 250C198 268 175 275 162 262M200 250C202 268 225 275 238 262"/><path d="M60 215L125 228M55 250L125 245M340 215L275 228M345 250L275 245"/>`),
  },
  {
    name: 'Montaña',
    svg: wrap(`<circle cx="310" cy="85" r="35"/><path d="M20 320L150 105L225 225L265 170L380 320Z"/><path d="M115 165L140 182L160 160L185 190"/><path d="M20 320H380"/><path d="M50 355C90 345 120 365 160 355S240 345 280 355S340 365 370 352"/><path d="M60 100C75 85 95 90 100 100C115 92 135 100 130 115H55C45 110 50 100 60 100Z"/>`),
  },
];

export const sampleUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function sampleBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen'))), 'image/png');
    };
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = sampleUrl(svg);
  });
}
