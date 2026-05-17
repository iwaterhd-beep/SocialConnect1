-- Vídeos en menú tablet (mismo bucket y columna image_path).

comment on column public.inventory_products.image_path is
  'Ruta en Storage (club_product_images/{club_id}/{product_id}.ext): imagen o vídeo para menú tablet.';

update storage.buckets
set
  file_size_limit = 15728640,
  allowed_mime_types = array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
where id = 'club_product_images';
