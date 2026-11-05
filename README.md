# DrawAR

Web local para calcar imágenes sobre papel real. Todo corre en el navegador: las imágenes no salen de tu red.

## Uso

```bash
pnpm install
pnpm dev
```

1. La terminal muestra un QR. Escanéalo con el celular (misma red Wi-Fi que la PC).
2. El navegador avisa que el certificado no es de confianza. Es normal: lo genera este proyecto, y la cámara exige HTTPS. Elige continuar.
3. Permite el acceso a la cámara.

Si el celular no conecta, permite Node.js en el firewall de Windows para redes privadas.

## Por túnel (recomendado)

Necesita [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) instalado. No pide cuenta, funciona fuera de tu Wi-Fi y no muestra el aviso de certificado.

```bash
pnpm tunnel
```

Compila la versión de producción, la sirve y muestra un QR. La URL cambia cada vez que lo arrancas y es pública mientras esté corriendo: cualquiera con el enlace puede ver la web. Ctrl+C la cierra. No se puede usar a la vez que `pnpm dev`, porque comparten el puerto 5173.

Para una sesión larga, sin depender de una terminal abierta:

```bash
pnpm tunnel --hours 3 --background
```

Se cierra solo al cumplir el tiempo, y la URL y el QR quedan en `tunnel.log`. Cloudflare no pone un límite de tiempo a estos túneles: lo que los corta es apagar o suspender la PC, o perder internet. Si el túnel se cae, una página ya abierta sigue funcionando, porque la app corre en el celular.

## Modos

- **Draw with Camera:** celular fijo sobre la hoja (un vaso o un soporte sirven). Calcas viendo la pantalla. Cuando quitas la hoja y la regresas, aunque vuelva girada o se haya movido de un golpe, la imagen se reajusta sola en cuanto la hoja se queda quieta. Si la hoja se ve entera sobre un fondo más oscuro, se guía por sus bordes, incluso en blanco. Si el celular está tan cerca que no se ven los bordes, compara tus trazos con lo que vio antes y con la imagen; para eso necesita algo ya dibujado. Se apaga en Más, con "Reajuste automático".
- **Draw with AR:** pon la hoja entera a la vista, sobre un fondo más oscuro que el papel, y pulsa "Fijar hoja". Funciona con hojas en blanco. La imagen se queda pegada al papel aunque muevas la hoja o el celular, y vuelve a su sitio si quitas la hoja y la regresas entera a la vista. Si la regresas girada, lo detecta por lo que lleves dibujado. En Más, "Tamaño de hoja" ofrece Carta, A4, A3 o la medida que detectó la cámara. A3 y A4 tienen la misma proporción, así que para seguir la hoja da igual cuál marque. "Fijar copia" deja copias para dibujar la imagen varias veces. Para cuadernos, paredes o lienzos que no caben en cuadro, usa "Usar marcas".
- **Draw with Screen:** caja de luz. Sube el brillo al máximo, pon "Bloquear" y coloca la hoja sobre la pantalla.

"Bloquear" evita mover la imagen sin querer. Para desbloquear, mantén pulsado el botón.

## Herramientas

- **Continuar:** el trabajo se guarda solo y aparece en el inicio. En AR, al volver a poner la hoja, reconoce tu dibujo y deja la imagen donde estaba, aunque la hoja esté en otro sitio o girada.
- **Exportar e importar:** lo guardado pertenece a una URL, y la del túnel cambia cada vez. El botón de compartir de cada proyecto lo saca a un solo archivo `.drawar.json`, que se abre con "Importar proyecto". También se abren los `.drawar` de versiones anteriores.
- **Editar:** recorta y quita el fondo antes de dibujar. Funciona mejor si el sujeto contrasta con el fondo y recortas cerca de él.
- **Etapas** (en Estilo): revela la imagen por pasos: contorno, sombras, medios tonos y completo.
- **Cuadrícula numerada:** 4, 8 o 12 cuadros, con letras y números para ubicar cada cuadro.
- **Comparar:** mantén el ojo para ver solo tu dibujo. "Parpadeo" alterna solo.
- **Time-lapse** (en Más): guarda una foto cada pocos segundos y al detenerlo crea un video. Se pierde si cierras la app antes de guardarlo.

## Instalarla en el celular

Abre la web por el túnel y usa "Instalar app" (en iPhone: Compartir y luego Agregar a inicio). La app guarda todo lo que necesita, así que después abre sin la PC ni el túnel.

Una app instalada queda ligada a la URL desde la que se instaló. Para pasar a una versión nueva, exporta tus proyectos, instálala desde la URL nueva e impórtalos.

## Técnica

Vite + TypeScript sin framework. Hay dos rastreadores, ambos en Web Workers:

- **Hoja** (`src/lib/sheet.ts`): sigue los cuatro bordes del papel. Busca el escalón claro-oscuro a lo largo de cada lado, descarta lo que no es recto (una mano, una sombra) y ajusta las esquinas. Sigue funcionando con un lado tapado. Una hoja perdida solo se acepta entera y quieta, porque media hoja A4 tiene la proporción de otra acostada. Una memoria de los trazos resuelve la orientación cuando regresa. Draw with Camera usa este mismo rastreador en segundo plano (`src/realign.ts`).
- **Trazos** (`src/lib/strokes.ts`): para cuando no se ven los bordes. Extrae el centro de cada trazo y busca el giro, la escala y la posición que los dejan sobre las líneas de la referencia, primero contra los trazos vistos antes y luego contra la imagen. Solo mueve la imagen si una posición gana con claridad.
- **Marcas** (`src/lib/tracker.worker.ts`): ORB + homografía con RANSAC contra una foto de referencia, con OpenCV.js. Solo se descarga si eliges "Usar marcas".

Si no encuentra la hoja, conserva la última pose buena y atenúa la imagen.
