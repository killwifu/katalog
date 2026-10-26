import { rejectReason, rejectSummary } from './uploadRun'

// Папка с компьютера продавца, которая станет альбомом.
export type PickedFolder = {
  name: string
  files: File[]
  bytes: number
  // Файлы не того формата или размера: в альбом не попадут.
  skipped: number
  // Почему пропущены — rejectSummary.
  skipReason: string
  // Вложенные папки: их содержимое не загружается.
  nested: number
}

// Файл и путь к нему от выбранного корня: ['Каталог', 'Куртки'].
// Без file — отметка «здесь есть папка»: пустую вложенную папку иначе
// не посчитать, файлов-то в ней нет.
type Entry = { dirs: string[]; file?: File }

// Системный мусор, который Finder и Проводник кладут в каждую папку.
// Считать его «пропущенным файлом» значит пугать продавца на ровном месте.
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i

// groupFolders раскладывает файлы по будущим альбомам.
//
// Одна папка — один альбом, вложенные папки не загружаются. Исключение —
// папка-контейнер: если в выбранной папке фотографий нет, а подпапки есть,
// альбомами становятся подпапки. Иначе продавец, у которого снимки лежат
// как «Каталог/Куртки, Каталог/Худи», выбрал бы «Каталог» и получил ноль
// альбомов: окно выбора папки отдаёт только одну папку за раз.
export function groupFolders(entries: Entry[]): PickedFolder[] {
  const clean = entries.filter((e) => e.dirs.length > 0 && !(e.file && JUNK.test(e.file.name)))
  const roots = [...new Set(clean.map((e) => e.dirs[0]))]
  const out: PickedFolder[] = []
  for (const root of roots) {
    const inRoot = clean.filter((e) => e.dirs[0] === root)
    const direct = inRoot.filter((e) => e.file && e.dirs.length === 1)
    const subdirs = [...new Set(inRoot.filter((e) => e.dirs.length > 1).map((e) => e.dirs[1]))]
    const hasPhotos = direct.some((e) => e.file && !rejectReason(e.file))
    if (hasPhotos || subdirs.length === 0) {
      out.push(build(root, direct, subdirs.length))
      continue
    }
    for (const sub of subdirs) {
      const inSub = inRoot.filter((e) => e.dirs[1] === sub)
      const deeper = new Set(inSub.filter((e) => e.dirs.length > 2).map((e) => e.dirs[2]))
      out.push(build(sub, inSub.filter((e) => e.file && e.dirs.length === 2), deeper.size))
    }
  }
  return out
}

function build(name: string, entries: Entry[], nested: number): PickedFolder {
  const files = entries
    .map((e) => e.file)
    .filter((f): f is File => Boolean(f) && !rejectReason(f as File))
    // Порядок в альбоме — по имени файла, как продавец видит папку у себя:
    // браузер отдаёт содержимое в произвольном порядке.
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
  return {
    name,
    files,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
    skipped: entries.length - files.length,
    skipReason: rejectSummary(entries.flatMap((e) => (e.file ? [e.file] : []))),
    nested,
  }
}

// Папки из <input webkitdirectory>: путь лежит в webkitRelativePath.
export function foldersFromInput(list: FileList): PickedFolder[] {
  return groupFolders(
    Array.from(list).map((file) => ({
      dirs: file.webkitRelativePath.split('/').slice(0, -1),
      file,
    })),
  )
}

// Глубже трёх уровней не ходим: дальше всё равно ничего не загружается,
// а папка с тысячами вложенных файлов подвесила бы вкладку.
const MAX_DEPTH = 3

// Папки, перетащенные в окно. Обычный dataTransfer.files папок не
// раскрывает — нужен обход через webkitGetAsEntry.
export async function foldersFromDrop(items: DataTransferItemList): Promise<PickedFolder[]> {
  // Входы надо забрать синхронно: после первого await список пустеет.
  const roots = Array.from(items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemDirectoryEntry => Boolean(entry?.isDirectory))
  const entries: Entry[] = []
  for (const root of roots) await walk(root, [root.name], entries)
  return groupFolders(entries)
}

async function walk(dir: FileSystemDirectoryEntry, dirs: string[], out: Entry[]): Promise<void> {
  const reader = dir.createReader()
  for (;;) {
    // readEntries отдаёт содержимое порциями (в Chrome по 100) — читаем
    // до пустого ответа, иначе большая папка обрежется молча.
    const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])))
    if (batch.length === 0) return
    for (const entry of batch) {
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
        )
        if (file) out.push({ dirs, file })
      } else if (entry.isDirectory) {
        out.push({ dirs: [...dirs, entry.name] })
        if (dirs.length < MAX_DEPTH) await walk(entry as FileSystemDirectoryEntry, [...dirs, entry.name], out)
      }
    }
  }
}
