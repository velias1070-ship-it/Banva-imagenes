# Pipelines de generación de imágenes con IA para e-commerce textil

Fecha: 2026-04-14
Fuente: Investigación encargada por Vicente Elías (BANVA HOME). Sintetiza benchmarks Arena.ai (4.5M votos, abril 2026), paper AAAI 2026 sobre fotografía textil, DreamBench++ (ICLR 2025), casos Photoroom/Wayfair/H&M/SHEIN/MercadoLibre, NVIDIA Retail Catalog Blueprint, análisis de costos fal.ai/Replicate/RunPod/Vast.ai, marco legal Chile (caso "39,000" + Proyecto Ley IA Boletín 16821-19) y Getty Images v. Stability AI (UK, nov 2025).
Tags: prompt, model-behavior, preprocessing, verification, qa, brand, cost, reliability

---

**FLUX.2 Pro con multi-referencia y Flux Kontext emergen como el stack dominante para fotografía textil generativa en 2026**, ofreciendo la mejor combinación de fidelidad de textura, preservación de identidad de producto y costo viable ($0.03-0.04/imagen). Para un volumen de 500-2.000 imágenes/mes, la ruta óptima es un pipeline híbrido de APIs hosteadas (fal.ai como proveedor principal) complementado con ComfyUI en RunPod Serverless para workflows personalizados que requieran ControlNet o LoRAs propios. El costo estimado total oscila entre **$25-120/mes** dependiendo del mix de modelos y nivel de personalización. Los tres modelos recomendados como base del pipeline son FLUX.2 Pro (calidad máxima de texturas, multi-referencia con hasta 10 imágenes), Flux Kontext Pro (edición contextual preservando identidad del producto) y Seedream 4.5 (volumen alto a bajo costo con excelente renderización de telas). A nivel legal en Chile, las imágenes puramente generadas por IA no son registrables como obra con derechos de autor, y MercadoLibre ya integra herramientas de generación IA nativamente para vendedores.

---

## Bloque 1 — Cómo funcionan los modelos de difusión y qué ha cambiado

### Arquitectura fundamental: del ruido a la imagen

Los modelos de difusión operan en dos fases. El **proceso forward** destruye progresivamente una imagen añadiendo ruido gaussiano en T pasos hasta obtener ruido puro. El **proceso reverse** entrena una red neuronal para revertir esa degradación, prediciendo y removiendo el ruido paso a paso hasta reconstruir una imagen coherente desde aleatoriedad pura. La innovación crítica para decisiones de ingeniería es que los modelos modernos no operan sobre píxeles directamente (una imagen 1024×1024 tiene ~3.1M valores), sino en un **espacio latente comprimido** mediante un VAE (Variational Autoencoder). El encoder del VAE comprime la imagen a un tensor ~48× menor, toda la difusión ocurre ahí, y el decoder reconstruye la imagen final. La calidad del VAE determina directamente cuánto detalle fino de texturas textiles se preserva.

Los modelos 2025-2026 han migrado de difusión clásica a **flow matching rectificado**. En vez de trayectorias ruidosas, aprenden caminos directos (líneas rectas) entre ruido y la imagen final, convergiendo en 20-30 pasos en vez de 50-100. FLUX.2 usa esta arquitectura con un transformer de 32B parámetros. El condicionamiento por texto ocurre mediante cross-attention: los tokens de imagen "consultan" embeddings de texto en cada capa del transformer, y cada región espacial atiende a lo que dice el prompt. La evolución en encoders de texto es notable: de CLIP (77 tokens, conceptos generales como "sábana blanca") a T5-XXL (256+ tokens, instrucciones detalladas como "sábana king con ribete doble azul marino, trama sateen 400 hilos") hasta Mistral-3 VLM 24B en FLUX.2, que aporta conocimiento del mundo real y soporte multilingüe.

### Comparativa de modelos líderes en 2026

El panorama de modelos ha cambiado drásticamente respecto a 2024. Los líderes actuales según **Arena.ai** (4.5M votos ciegos, abril 2026) son modelos nativamente multimodales, no solo difusión.

| Modelo | ELO Arena | Precio/img | Res. máx. | Multi-ref | Fine-tune | Textura tela (1-5) | Licencia |
|--------|-----------|------------|-----------|-----------|-----------|---------------------|----------|
| Gemini 3.1 Flash Image ("Nano Banana 2") | 1264 (#1) | $0.045 | 4K | ✅ 14 imgs | ❌ | 4 | Propietario |
| GPT Image 1.5 High | 1241 (#2) | $0.133 | 1536px | ✅ edición | ❌ | 4 | Propietario |
| Gemini 3 Pro Image ("Nano Banana Pro") | 1237 (#3) | $0.134 | 4K | ✅ 14 imgs | ❌ | 5 | Propietario |
| FLUX.2 Max | 1167 (#8) | $0.08 | 4MP | ✅ 10 imgs | ❌ | 5 | Propietario API |
| FLUX.2 Pro | 1157 (#10) | $0.03/MP | 4MP | ✅ 10 imgs | ❌ | 5 | Propietario API |
| Seedream 4.5 | 1144 (#16) | $0.027-0.04 | 2048² | ✅ 10 imgs | ❌ | 4 | Propietario |
| Qwen Image 2512 | 1133 (#19) | Variable | 2K | ✅ | ✅ LoRA | 3 | Apache 2.0 |
| FLUX.2 Dev | 1149 (#14) | $0.012/MP | 4MP | ✅ multi | ✅ LoRA | 5 | No-comercial |
| FLUX.2 Klein | ~1024-1069 | ~$0 local | 2MP | ✅ | ✅ LoRA | 4 | Apache 2.0 |
| SDXL | No rankeado | $0.003 | 1024² | ❌ | ✅ LoRA | 3 | Open RAIL-M |
| SD 3.5 Large | 938 (#53) | $0.04 | 1024² | ❌ | ✅ LoRA | 4 | Community (<$1M) |

**FLUX.2** (noviembre 2025 - enero 2026) es el modelo más relevante para este caso de uso. Su arquitectura integra un transformer de 32B parámetros con Mistral-3 VLM 24B, un VAE re-entrenado desde cero (licencia Apache 2.0) y soporte para JSON prompting estructurado. Black Forest Labs específicamente destaca su capacidad con "fabric textures to architectural elements". La variante **Klein** (enero 2026, Apache 2.0) es particularmente significativa: destilada de FLUX.2, genera imágenes en sub-segundo y es completamente fine-tuneable en GPUs consumer, eliminando la barrera de licencia comercial.

**Nano Banana 2** (Gemini 3.1 Flash Image, febrero 2026) ha escalado al #1 del Arena gracias a su integración con web search grounding. Genera imágenes en 1-3 segundos, soporta hasta 14 referencias, y tiene un tier gratuito generoso. Sin embargo, tiene degradación documentada después de 3-4 ediciones iterativas y comprime automáticamente imágenes de entrada grandes.

**Stable Diffusion 3.5** (ELO 938, #53) ha quedado significativamente atrás de la competencia frontier y no se recomienda como modelo principal para nuevos proyectos, aunque mantiene valor por su licencia Community (gratis bajo $1M de revenue anual) y soporte maduro de ControlNet.

### Open-source vs propietario: la brecha se cierra

El ecosistema open-source ha alcanzado calidad competitiva en 2026. FLUX.2 Dev (open-weights) logra un **66.6% de win rate** contra todas las alternativas open-weight en text-to-image. FLUX.2 Klein (Apache 2.0) democratiza la calidad near-frontier con inferencia sub-segundo en GPU consumer. Qwen-Image 2.0 de Alibaba ofrece LoRA, ComfyUI nativo y tipografía profesional bajo Apache 2.0.

La tendencia clave es la **convergencia generación/edición**: FLUX.2 y Seedream 4.5 unifican text-to-image y edición en un solo modelo, eliminando la necesidad de pipelines separados. La multi-referencia se ha convertido en estándar (de 0 imágenes de entrada en 2023 a 10-14 simultáneas en 2026), lo cual es transformativo para mantener consistencia de producto textil en diferentes escenas.

---

## Bloque 2 — Técnicas de control para combinar hero y swatch

### IPAdapter: potente pero limitado en Flux

IPAdapter funciona como "un LoRA de una sola imagen": codifica una imagen de referencia mediante CLIP/SigLIP y la inyecta en las capas de cross-attention del modelo. Para SDXL, las variantes Plus y Style Transfer Precise (junio 2024) producen resultados robustos para transferencia de estilo. Sin embargo, para Flux la situación es menos madura. Las implementaciones de InstantX/Shakker-Labs y XLabs AI son funcionales pero múltiples fuentes reportan que el **IPAdapter para Flux no es suficientemente potente para transferencia de estilo fiel**: fuerza IPA alta degrada calidad de imagen. Se recomienda peso IPA menor a 0.5 combinado con ControlNet e Img2Img. Nota crítica: Matteo Spinelli (creador original) anunció modo "maintenance only" en abril 2025, cesando desarrollo activo.

Para textiles específicamente, IPAdapter captura la "esencia" del estilo pero no reproduce con fidelidad los detalles granulares de patrones. Es mejor para transferir el "mood" general que la textura exacta de un tejido.

### ControlNet: el control espacial indispensable

ControlNet añade condicionamiento espacial mediante mapas de control procesados por una copia del encoder entrenada por separado. Para Flux, el ecosistema ha madurado significativamente con **ControlNet Union Pro 2.0** (Shakker-Labs, abril 2025): modelo unificado de 3.98 GB que soporta Canny, Soft Edge, Depth, Pose y Gray simultáneamente. Los ControlNets oficiales de BFL incluyen FLUX.1-Depth-dev y FLUX.1-Canny-dev. Alibaba contribuyó FLUX.2-dev-Fun-Controlnet-Union con soporte para 7 modos más inpainting.

Para textiles, **ControlNet Tile** es la técnica más valiosa: preserva detalles de textura durante upscaling y refinamiento. Sin embargo, Union Pro 2.0 de Shakker-Labs no incluye modo Tile, requiriendo el modelo de InstantX separado.

### Flux Kontext: la innovación más significativa para este caso de uso

Flux Kontext introduce un enfoque radicalmente diferente a IPAdapter. En vez de inyectar embeddings en cross-attention, **concatena las imágenes de referencia como tokens latentes directamente en la secuencia de entrada** del modelo, junto con el prompt de texto. Esto permite que el modelo "vea" la imagen completa, no solo una representación semántica comprimida.

| Aspecto | IPAdapter | Flux Kontext |
|---------|-----------|--------------|
| Inyección | Cross-attention via CLIP/SigLIP | Concatenación directa en espacio latente |
| Fidelidad de referencia | Media (semántica) | Alta (pixel-level) |
| Modelos adicionales | Encoder + adapter separados | Integrado en el modelo |
| Multi-imagen | Limitado, degradante | Nativo, hasta 3-4 refs |
| Edición iterativa | No nativo | Multi-turn con consistencia |
| Precio | Gratuito (local) | $0.04/img (Pro), $0.08 (Max) |

Dos workflows funcionan en ComfyUI: **Image Stitching** (imágenes unidas horizontalmente, codificadas como un solo latente — más rápido y generalmente mejores resultados) y **Reference Latents separados** (cada imagen codificada independientemente — más control pero ~2× más lento).

### Pipeline óptimo para "hero + swatches textiles"

Tres configuraciones evaluadas, de menor a mayor complejidad:

**Opción A — Flux Kontext directo** (recomendada como punto de partida): Concatenar imagen hero + swatch(es) horizontalmente → VAE encode → prompt descriptivo referenciando cada zona → KSampler. Pipeline simple, integrado, buena preservación visual. Limitación: control limitado sobre exactamente dónde se aplica cada textura.

**Opción B — Pipeline multi-técnica** (máxima fidelidad): Fase 1: ControlNet Depth+Canny sobre hero para composición base. Fase 2: GroundingDINO + SAM2 para crear máscara automática de la zona textil. Fase 3: IPAdapter (peso 0.5-0.7) con swatch + DifferentialDiffusion para transición suave + Regional Conditioning con prompt de textura. Fase 4: ControlNet Tile para upscaling preservando detalle. Máximo control pero alta complejidad.

**Opción C — Híbrido** (balance práctico): Flux Kontext genera composición base → SAM2+GroundingDINO crean máscara precisa → Inpainting con DifferentialDiffusion refina zona textil → ControlNet Tile para upscaling final.

**Para producción e-commerce con equipo reducido, Opción A vía API es la recomendación primaria.** Opción C se justifica solo cuando la fidelidad textil de Kontext sea insuficiente para productos con patrones complejos (estampados detallados, jacquards).

### Imágenes de referencia óptimas para textiles

Para **Flux Kontext/multi-image** (zero-shot): **2-3 imágenes** proporcionan la mejor consistencia. El límite práctico son 3 referencias antes de que la resolución individual se degrade (4096px de ancho total). Para **LoRA training**: 15-30 imágenes con mezcla de 50% flat patterns sobre fondo neutro, 25% con drapeado natural y 25% close-ups macro del tejido. El swatch ideal es escaneado a 300-600 DPI, formato PNG lossless, con fondo neutro y sin auto-mejoras del scanner. Un estudio publicado por Taylor & Francis (2024) encontró que imágenes textiles generadas por IA fueron calificadas como "más creativas y comprables" cuando se proyectaron sobre prendas, validando la viabilidad del enfoque.

---

## Bloque 3 — Fine-tuning LoRA y personalización de catálogo

### Entrenar un LoRA para textiles: requisitos concretos

Flux es significativamente más eficiente que generaciones anteriores para LoRA training. **25-30 imágenes de alta calidad producen resultados excelentes** en Flux, donde SDXL necesitaría 70-200 y SD 1.5 requeriría 200+. La resolución óptima es 1024×1024 con aspect ratio bucketing activado.

El etiquetado es crítico: Flux utiliza la información del caption mucho más intensamente que SDXL durante entrenamiento e inferencia. Las mejores prácticas incluyen captions descriptivos completos en lenguaje natural (no solo tags), un trigger word poco común (ej: "txtrfbrc"), y descripción explícita del tipo de tejido, patrón, textura, color y presentación. Para auto-captioning, JoyCaption y Gemini Pro vía API producen la mayor calidad; BLIP2/Florence logran ~80% de precisión como punto de partida.

Los parámetros clave para Flux LoRA de productos textiles son: **rank 48-64** (captura identidad reconocible manteniendo flexibilidad), learning rate 1e-4 con AdamW8bit o LR=1 con Prodigy (auto-ajuste), 500-2.000 steps, y sin imágenes de regularización (no mejoran resultados en Flux según investigaciones extensivas).

### Herramientas de entrenamiento y costos

| Herramienta | Soporte Flux | VRAM mín. | Costo por LoRA | Tiempo |
|-------------|-------------|-----------|----------------|--------|
| fal.ai (flux-lora-fast-training) | ✅ Flux.1/2 | Cloud | **$2.40** (1000 steps) | 10-15 min |
| Replicate (fast-flux-trainer) | ✅ Flux.1 | Cloud (8×H100) | $3-8 | 5-15 min |
| Civitai Trainer | ✅ Flux | Cloud | ~$4-8 | 20-25 min |
| Kohya_ss en RunPod | ✅ Flux.1/2 | RTX 4090 24GB | **$1.17** (3h × $0.39/h) | 2-4h |
| AI Toolkit (Ostris) | ✅ Flux.1/2 | 12-24GB | Similar RunPod | 20-30% más rápido que Kohya |

**fal.ai es la opción más práctica para equipos reducidos**: $2.40 por LoRA sin infraestructura propia, resultado en 10-15 minutos. Para iteración intensiva o control máximo, Kohya_ss en RunPod RTX 4090 ($0.39/hr) es la alternativa más económica.

### Estrategia de granularidad: dos niveles combinados

La recomendación para producción textil es un **enfoque híbrido de dos niveles**. Primero, un LoRA de estilo de marca (rank 32-48) que capture iluminación, paleta de colores y composición general — un solo LoRA reutilizable para todo el catálogo. Segundo, LoRAs por categoría de producto (rank 48-64): "Ropa de cama", "Toallas", "Cortinas". Ambos se combinan en inferencia con pesos 0.6-0.8 cada uno. La combinación de 2-3 LoRAs funciona bien; la calidad degrada al apilar más de 3 simultáneamente.

La alternativa de IPAdapter con imágenes de referencia (sin entrenamiento) es viable para prototipado rápido y equipos sin capacidad de training, pero LoRA produce resultados consistentemente más controlados y fieles para catálogos de producción.

### Licenciamiento comercial: la cuestión crítica

**SDXL** (CreativeML Open RAIL-M) es la opción más permisiva: uso comercial sin restricciones de revenue, LoRA training completamente libre. **Flux.1 Schnell** (Apache 2.0) y **FLUX.2 Klein** (Apache 2.0) son completamente libres. **SD 3.5** es gratis bajo $1M de revenue anual.

**Flux.1/2 Dev** tiene licencia no-comercial estricta. Sin embargo, plataformas como Replicate y fal.ai incluyen derechos de uso comercial en sus términos de servicio cuando se usa su versión hosted. Los LoRAs heredan la licencia del modelo base — entrenar un LoRA sobre Flux Dev para uso comercial requiere o licencia de BFL (reportada en ~$999/mes) o usar los servicios hosted de fal.ai/Replicate que cubren el derecho comercial en su pricing.

---

## Bloque 4 — Arquitectura de pipeline para producción

### Cómo construyen sus pipelines las empresas líderes

**Photoroom** ($60M ARR) es el caso más documentado. Desarrollaron PRX (Photoroom eXperimental), un modelo fundacional propio basado en DiT con T5Gemma 2B como text encoder y un framework GPU-aware con transferencias CPU-GPU no bloqueantes. Logran inferencia sub-segundo. Su pipeline: usuario sube foto → IA remueve fondo → genera escena fotorrealista desde prompt → resultado en menos de 5 segundos.

**NVIDIA publicó un Blueprint de Retail Catalog Enrichment** que es el caso más cercano a una arquitectura completa para e-commerce: usa Nemotron VLM para análisis de contenido, Nemotron LLM para planificación de prompts, FLUX Kontext para generar variaciones de producto, TRELLIS para 3D, y QA automatizado basado en VLM.

**MercadoLibre** desarrolló GenAds con Mutt Data (AWS Partner), usando Stable Diffusion en Amazon Bedrock con Claude 3 Sonnet para generación de prompts. Resultado: **CTR aumentó 25%** para vendedores pequeños. Ya ofrece "Generar fotos con IA" directamente en la edición de publicaciones.

### Herramientas de orquestación comparadas

**ComfyUI** domina como orquestador en 2026. Su arquitectura de nodos permite diseñar workflows visualmente, exportarlos como JSON y ejecutarlos vía API (endpoints `/prompt`, `/ws`, `/history`). NVIDIA colaboró directamente con BFL y ComfyUI para optimización FP8 de FLUX.2. El ecosistema tiene soporte para todos los modelos relevantes. Para despliegue en producción, **ComfyDeploy** ofrece 1-click deployment con auto-scaling y version history; **RunPod Serverless** ofrece máxima flexibilidad con setup de ~20 minutos.

**Diffusers (HuggingFace)** es preferible cuando se necesita lógica de negocio compleja integrada en Python, pipelines de training, o control total del código. ComfyUI es más eficiente en memoria (puede cargar 2 modelos SDXL donde Diffusers falla con 1).

Para **APIs hosteadas**, fal.ai ofrece la mejor relación calidad/precio: 600+ modelos, CUDA kernels propios (4× más rápido en Flux), cold starts de 5-10s, pricing per-use sin mínimos. Replicate tiene mejor documentación y soporte para custom models vía Cog. Google ofrece el tier gratuito más generoso (500-1000 imágenes/día en AI Studio).

| Proveedor | Flux 2 Pro | Flux Kontext Pro | Seedream 4.5 | Imagen 4 Fast | GPT Image 1.5 Med |
|-----------|------------|------------------|--------------|---------------|---------------------|
| fal.ai | $0.030 | $0.040 | $0.040 | — | — |
| Replicate | $0.055 | Disponible | — | — | — |
| Google | — | — | — | $0.020 | — |
| OpenAI | — | — | — | — | $0.034-0.050 |

### Sistema de QA automático

El pipeline de QA recomendado tiene tres capas. Primero, **CLIPScore como filtro rápido**: calcula similitud coseno entre imagen generada y prompt/swatch original. Umbral aceptable >0.30, bueno >0.35. Segundo, **métricas perceptuales** para evaluación cuantitativa: SSIM para similitud estructural, **LPIPS** (la más relevante) para similitud perceptual usando features de VGG/AlexNet, y Delta-E para fidelidad de color (crítico para textiles). Tercero, **VLM review** con un modelo como Gemini 2.5 Flash ($0.002-0.005 por revisión) que evalúa fidelidad de textura, precisión de color, artefactos, coherencia de iluminación y calidad general, retornando JSON estructurado con scoring y decisión aprobado/rechazado.

El flujo completo: generar imagen → CLIPScore (filtro rápido <1s) → si pasa → LPIPS + Delta-E (evaluación cuantitativa) → si pasa → VLM review (evaluación cualitativa) → aprobado o regenerar con parámetros ajustados. Para batch monitoring a lo largo del tiempo, FID evalúa la calidad general del modelo sobre distribuciones completas (requiere mínimo ~2.048 imágenes).

### Tracking de experimentos

Para equipos reducidos, **W&B (Weights & Biases)** es la recomendación primaria: free tier suficiente, image logging nativo con `wandb.Image()`, tablas comparativas, tracking automático de GPU. MLflow es la alternativa open-source (Apache 2.0) con self-hosting. Para la fase inicial, una Google Sheet con links a imágenes en Supabase Storage es perfectamente viable. Lo esencial es trackear: modelo, prompt template, steps, CFG, sampler, seed, LoRA (nombre + peso), CLIPScore, LPIPS, costo por imagen y workflow JSON de ComfyUI.

---

## Bloque 5 — Cuánto cuesta realmente generar imágenes

### Costo por imagen según modelo y volumen

| Servicio/Modelo | 500 imgs/mes | 2.000 imgs/mes | 10.000 imgs/mes |
|-----------------|-------------|----------------|-----------------|
| fal.ai FLUX.2 Turbo | $4-10 | $16-42 | $80-210 |
| fal.ai FLUX.2 Pro | $15 | $60 | $300 |
| fal.ai Flux Kontext Pro | $20 | $80 | $400 |
| Google Imagen 4 Fast | $10 | $40 | $200 |
| Google Nano Banana 2 (Batch) | $10 | $39 | $195 |
| OpenAI GPT Image 1 Mini Low | $2.50 | $10 | $50 |
| Replicate SDXL | $1.50 | $6 | $30 |
| RunPod Serverless RTX 4090 (Flux Dev) | $2.30 | $9.20 | $46 |
| Vast.ai RTX 4090 (Flux Dev, on-demand) | $0.60 | $2.42 | $12.08 |

**El hallazgo más significativo es la diferencia de 5-25× entre APIs y self-hosted en GPU cloud.** Una RTX 4090 en Vast.ai ($0.29/hr) genera imágenes Flux Dev a **$0.001/imagen**, contra $0.025-0.030 en APIs. Sin embargo, esta diferencia se reduce al considerar ingeniería necesaria, tiempo de setup, mantenimiento y confiabilidad.

### Cuándo conviene self-hosted vs API

El breakpoint de volumen depende del modelo API de comparación. Contra **FLUX.2 Pro a $0.03/imagen**, hardware propio (RTX 4090, sistema completo amortizado a 3 años = $97/mes + $16 electricidad) se justifica a partir de **~5.000 imágenes/mes**. Contra **fal.ai FLUX Turbo a $0.008/imagen**, el breakpoint sube a **~15.000 imágenes/mes**. Para 500-2.000 imágenes/mes, API pura es la elección correcta.

La estrategia híbrida más práctica para un equipo reducido: **RunPod Serverless RTX 4090** como baseline (pago por segundo, sin idle costs, auto-scaling 0→N) complementado con APIs directas (fal.ai/Google) para modelos propietarios no hospedables (Kontext Pro, Nano Banana). Este enfoque ofrece costos de self-hosted sin el overhead operacional de mantener hardware.

### Infraestructura y GPU recomendada

**La RTX 4090 (24GB GDDR6X) es la GPU con mejor relación precio/rendimiento** para generación de imágenes. Genera Flux Dev FP16 en 15-18 segundos y SDXL en 5-7 segundos. Disponible a $1.400-1.800 usada. La RTX 5090 (32GB GDDR7) es superior pero cuesta $3.000-4.500 por escasez de GDDR7 en abril 2026.

Requisitos de VRAM por modelo: Flux Dev FP16 necesita ~24GB (ajustado en RTX 4090); Flux Dev FP8 necesita ~12-13GB (cómodo); SDXL completo usa ~7GB. Con ControlNet/IPAdapter adicional, sumar 4-8GB. Sistema mínimo: 32GB RAM, 500GB NVMe, PSU 850W+.

### Arquitectura de batch processing

Para integrar con Supabase + Vercel, la arquitectura recomendada usa **BullMQ (Node.js)** con Redis (Upstash free tier) como sistema de colas. Vercel API Routes actúan como productores que encolan trabajos en BullMQ; los workers (ComfyUI en RunPod Serverless o GPU propia) consumen la cola; las imágenes generadas se almacenan en Supabase Storage con metadata en PostgreSQL. Con una sola RTX 4090, el throughput es **200-360 imágenes/hora con Flux Dev**, suficiente para generar 2.000 imágenes en un batch nocturno de ~8 horas.

---

## Bloque 6 — Desafíos específicos de textiles y marco legal

### Qué están haciendo las grandes marcas

**IKEA** lleva usando imágenes CGI desde 2006 (75% de su catálogo para 2014) y migró a IA generativa en 2025 con un anuncio creado con Google Veo equivalente a $100K de producción tradicional. **Wayfair** lanzó Muse (febrero 2025), un motor de inspiración con escenas de interiores generadas por IA que enlaza productos reales, incrementando duración de visita y conversiones. **H&M** creó 30 "gemelos digitales" de sus modelos (marzo 2025) para generar variaciones de ropa sin sesiones fotográficas, con pago equivalente y derechos retenidos por los modelos. **SHEIN** procesa ~3.000 SKUs nuevos diarios con workflows propietarios de Stable Diffusion, ahorrando un estimado de $47M anuales en fotografía tradicional. **MercadoLibre** usa Stable Diffusion en Amazon Bedrock con Claude 3 Sonnet para GenAds, logrando **25% de aumento en CTR**.

Un dato de precaución: ASOS reportó que productos con modelos AI tuvieron **18% más devoluciones** por expectativas incorrectas de ajuste y textura. El consenso de la industria es mantener fotografía real para la imagen principal y usar IA para imágenes secundarias/lifestyle.

### Los seis problemas de generar texturas textiles con IA

**Alucinación de patrones** es el problema más frecuente: la IA inventa motivos inexistentes o transforma patrones regulares en irregulares. La solución más efectiva es LoRA fine-tuning sobre imágenes del catálogo propio combinado con IPAdapter/reference images como condicionamiento adicional.

**Pérdida de detalle en tejidos** ocurre porque las texturas thread-level desaparecen en resoluciones estándar. El 71% de compradores pierde confianza cuando detalles como costura o textura se ven incorrectos. ControlNet Tile con upscaling multi-paso es la mitigación principal.

**Comportamiento físico incorrecto** se manifiesta como pliegues y drapeado irreales, donde el peso de la tela no corresponde al material. Los prompts deben describir explícitamente peso, caída y rigidez del material, y las reference images deben incluir la tela real con drapeado natural, no solo swatches planos.

**Problemas de escala de patrones**, **shifts de color** (mitigables con workflow calibrado end-to-end y Delta-E como métrica de QA) y **confusión de materiales** (seda que parece algodón) completan el conjunto. Para todos estos, el enfoque más robusto es **combinar LoRA entrenado en producto real + Flux Kontext con multi-referencia + QA automático con VLM**.

### Modelos y herramientas especializadas para textiles

Un paper del AAAI (2026) evaluó checkpoints para fotografía textil y recomienda **Realistic Vision v5.1** para fotorrealismo y **DreamShaper v8** para preservación de textura de tela, ambos sobre SD 1.5 con LoRA. Para interiores, el modelo `adirik/interior-design` en Replicate genera escenas fotorrealistas de habitaciones con guía ControlNet. **PatternedAI** (patterned.ai) genera patrones seamless print-ready para textiles, usado por 600K+ diseñadores. **Jaqrd.com** es específico para diseño textil con opciones de manufactura.

### Marco legal en Chile y MercadoLibre

**Chile rechazó registrar imágenes generadas con IA como obra con derechos de autor** (caso "39,000" con Midjourney). La Ley chilena requiere persona natural como autor, y la IA no califica. El Proyecto de Ley de IA (Boletín 16821-19), aprobado por la Cámara en agosto 2025, está en revisión del Senado e introduce un marco de riesgo escalonado inspirado en el EU AI Act, con excepción para text/data mining en entrenamiento de IA siempre que no resulte en explotación comercial directa.

En el contexto de **Getty Images v. Stability AI** (UK, noviembre 2025), el tribunal dictaminó que Stable Diffusion no almacena ni reproduce obras protegidas, un precedente favorable para el uso de modelos de difusión en producción comercial.

**MercadoLibre** ofrece generación de fotos AI directamente en la plataforma y usa Vue.ai para moderación automatizada de imágenes. No se encontró política explícita que prohíba imágenes AI generadas, pero sí requisitos de representación precisa del producto. La recomendación práctica es usar imagen principal con fotografía real del producto (o imagen AI con producto real como base) e imágenes secundarias con escenas lifestyle generadas.

---

## Bloque 7 — Quién lidera según los benchmarks objetivos

### Rankings Arena.ai: Google y OpenAI dominan, FLUX compite

El leaderboard de Arena.ai (4.5M votos ciegos, abril 2026) muestra una clara jerarquía. **Nano Banana 2 lidera con ELO 1264**, seguido de GPT Image 1.5 (1241) y Nano Banana Pro (1237). FLUX.2 se posiciona fuerte en #8-#14 (Max 1167, Pro 1157, Dev 1149). Seedream 4.5 ocupa #16 (1144). El dato más notable es que **SD 3.5 Large está en #53 (938)**, confirmando que Stable Diffusion ha quedado significativamente atrás de la competencia frontier.

En la categoría de **edición de imagen**, GPT Image 1.5 lidera (1270), seguido de Nano Banana Pro (1251) y HunyuanImage 3.0 Instruct (1223, mejor open-weight en edición).

### Preservación de identidad: Kontext y MUSIC lideran

El benchmark **DreamBench++** (ICLR 2025, 1.350 prompts, GPT-4o como evaluador) revela que DreamBooth LoRA logra el mejor balance entre preservación de concepto y seguimiento de prompt (CP·PF = 0.517), mientras IP-Adapter-Plus excele en preservación (CP = 0.833) pero falla en seguimiento de prompt (PF = 0.413).

**Flux Kontext** logra ~0.908 de similitud AuraFace en ediciones iterativas multi-turno, superando a Gen-4 y GPT-Image en drift de identidad. Para generación multi-sujeto, **MUSIC** (abril 2025) es el nuevo estado del arte con DINO 0.622 y CLIP-I 0.812, superando a UNO, OmniGen y FLUX.1 IP-Adapter.

### Modelos recomendados por capacidad específica para textiles

Para **renderización de texturas de tela**: Flux 2 Pro/Max y Seedream 4.5 (que específicamente optimiza "fabric weaves y surfaces orgánicas"). Para **escenas de interior**: Flux 2 Max (excelente simulación de luz volumétrica indoor) y Nano Banana Pro/2 (conocimiento contextual del mundo real). Para **fotorrealismo de producto**: Flux 2 Pro lidera en Artificial Analysis con ELO 1265 en fotorrealismo. Para **precisión de color**: Flux 2 Pro soporta códigos HEX nativamente para trabajo de marca. Para **multi-referencia**: Flux Kontext (AuraFace ~0.908) y Flux 2 Pro (hasta 10 referencias).

---

## Recomendación final de stack

Para un equipo técnico reducido con 500-2.000 imágenes/mes, stack Supabase + Vercel + Claude Code, y objetivo de balance entre APIs y self-hosting selectivo, la configuración recomendada es:

**Generación primaria**: fal.ai como proveedor principal de APIs. FLUX.2 Pro ($0.030/img) para hero shots con multi-referencia. Flux Kontext Pro ($0.040/img) para edición contextual manteniendo identidad de producto. Seedream 4.5 ($0.040/img) o Imagen 4 Fast ($0.020/img) para volumen alto de variaciones. Costo estimado: **$40-100/mes** para 1.000-2.000 imágenes.

**Self-hosting selectivo**: ComfyUI en RunPod Serverless (RTX 4090, $0.77/hr activo) para workflows que requieran LoRAs propios, ControlNet Tile, o pipelines multi-técnica. Activar solo cuando se necesite (pay-per-second, escala a 0 cuando no hay carga). Costo estimado: **$5-25/mes** adicionales.

**Fine-tuning**: fal.ai flux-lora-fast-training ($2.40/LoRA). Entrenar un LoRA de estilo de marca + LoRAs por categoría de producto. Usar el modelo comercialmente vía fal.ai (derechos incluidos). Costo inicial: ~$15-30 por el set completo de LoRAs.

**QA automático**: CLIPScore como filtro rápido (computar localmente) → Gemini 2.5 Flash como VLM reviewer ($0.002-0.005/revisión). Costo QA: **$2-10/mes**.

**Orquestación**: BullMQ + Redis (Upstash free tier) para cola de trabajos, Supabase para estado y storage, Vercel API Routes como productores. W&B free tier para experiment tracking.

**Costo total estimado del pipeline**: $50-160/mes para 1.000-2.000 imágenes, incluyendo generación, QA y almacenamiento. Esto representa **$0.03-0.08 por imagen final aprobada**, comparado con $25-100 por imagen en fotografía tradicional de producto — una reducción de costos de **99%** con calidad suficiente para imágenes secundarias/lifestyle y, con refinamiento del pipeline, potencialmente viable para hero shots.
