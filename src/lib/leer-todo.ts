// Lectura completa de una tabla de Supabase, por páginas. La usan /api/productos
// (base de inventario) y la lista de /projects (base propia y de inventario):
// una lectura se corta en 1.000 filas sin dar error, solo con filas de menos.

// La base de inventario entrega como máximo 1.000 filas por consulta aunque se
// pida más: con .limit(2000) la lista perdía publicaciones (29-sep-2026: el
// limpiapiés de coco MLC2250580065 no aparecía). Se lee por páginas, ordenado
// por id, hasta una página vacía.
export async function leerTodo<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const filas: T[] = [];
  for (;;) {
    const { data, error } = await pagina(filas.length, filas.length + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return filas;
    filas.push(...data);
  }
}
