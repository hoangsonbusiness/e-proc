import {
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useState,
  useMemo,
} from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { registerJavaCompletions } from '../hooks/useMonacoJavaCompletions';
import { useFrontendCompletions } from '../hooks/useFrontendCompletions';

// ─── Language options displayed in the selector dropdown ──────────────────

export const LANGUAGE_OPTIONS: { value: SupportedLanguage; label: string }[] = [
  { value: 'java',       label: 'Java' },
  { value: 'sql',        label: 'SQL' },
  { value: 'html',       label: 'HTML / Bootstrap 5' },
  { value: 'css',        label: 'CSS' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'plaintext',  label: 'Plain Text' },
];

export type SupportedLanguage = 'java' | 'sql' | 'html' | 'css' | 'javascript' | 'plaintext';

// ─── Auto-detect language from question metadata ───────────────────────────

export function detectLanguage(
  questionType?: string,
  questionModule?: string
): SupportedLanguage {
  const combined = `${questionType ?? ''} ${questionModule ?? ''}`.toLowerCase();

  if (/\bsql\b/.test(combined)) return 'sql';
  if (/\bhtml\b|\bbootstrap\b/.test(combined)) return 'html';
  if (/\bcss\b/.test(combined)) return 'css';
  if (/\bjavascript\b|\bjs\b|\bdom\b/.test(combined)) return 'javascript';
  // Default to java for all Java/Spring/Hibernate contexts
  return 'java';
}

// ─── Handle exposed via ref ───────────────────────────────────────────────

export interface CodeEditorHandle {
  focus(): void;
}

// ─── Props ────────────────────────────────────────────────────────────────

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onCopyAttempt: () => void;
  onCutAttempt: () => void;
  onPasteAttempt: () => void;
  disabled?: boolean;
  defaultLanguage?: SupportedLanguage;
  height?: string;
}

// ─── Component ────────────────────────────────────────────────────────────

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  function CodeEditor(
    {
      value,
      onChange,
      onCopyAttempt,
      onCutAttempt,
      onPasteAttempt,
      disabled = false,
      defaultLanguage = 'java',
      height = '400px',
    },
    ref
  ) {
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof Monaco | null>(null);
    const [monacoInstance, setMonacoInstance] = useState<typeof Monaco | null>(null);
    const [language, setLanguage] = useState<SupportedLanguage>(defaultLanguage);
    const [showGuide, setShowGuide] = useState(false);

    // Register frontend completions (HTML/CSS/JS/Bootstrap 5)
    // monacoInstance is set in handleBeforeMount; useFrontendCompletions
    // is a no-op until monacoInstance becomes non-null.
    useFrontendCompletions(monacoInstance);

    const toggleGuide = useCallback(() => setShowGuide(v => !v), []);

    // ── Prefix reference table data ────────────────────────────────────────
    const PREFIX_GROUPS = useMemo(() => [
      // ─── Java Core Snippets ─────────────────────────────────────────────
      {
        group: '⚙️ Java Core Snippets',
        rows: [
          ['psvm', 'public static void main(String[] args)'],
          ['sout', 'System.out.println()'],
          ['souf', 'System.out.printf()'],
          ['fori', 'for loop (index)'],
          ['foreach', 'for-each loop'],
          ['trycatch', 'try-catch block'],
          ['tryfin', 'try-catch-finally block'],
          ['ifnull', 'if (x == null) check'],
          ['lambda', '(x) -> expression'],
          ['stream', 'Stream pipeline chain'],
          ['class', 'public class {}'],
          ['interface', 'public interface {}'],
          ['enum', 'public enum {}'],
          ['record', 'public record (fields) {}'],
          ['getter', 'getXxx() method'],
          ['setter', 'setXxx() method'],
          ['tostring', 'toString() override'],
          ['hashequals', 'hashCode() + equals() override'],
          ['override', '@Override method stub'],
        ],
      },
      // ─── String / StringBuilder ─────────────────────────────────────────
      {
        group: '📝 String / StringBuilder',
        rows: [
          ['str', 'String instance — str.length(), str.substring(), str.split(), str.replace(), str.contains(), str.indexOf(), str.trim(), str.strip(), str.toUpperCase(), str.charAt(), str.isEmpty(), str.isBlank(), str.startsWith(), str.endsWith(), str.matches(), str.toCharArray(), str.format(), str.lines(), str.repeat(), str.intern(), str.chars(), str.valueOf()'],
          ['sb', 'StringBuilder — sb.append(), sb.insert(), sb.delete(), sb.replace(), sb.reverse(), sb.toString(), sb.length(), sb.charAt(), sb.indexOf(), sb.deleteCharAt()'],
        ],
      },
      // ─── Collections ────────────────────────────────────────────────────
      {
        group: '📦 Collections (instances)',
        rows: [
          ['list', 'List<T> — list.add(), list.get(), list.remove(), list.size(), list.contains(), list.set(), list.clear(), list.indexOf(), list.isEmpty(), list.subList(), list.iterator(), list.stream(), list.forEach(), list.sort(), list.toArray()'],
          ['map', 'Map<K,V> — map.put(), map.get(), map.containsKey(), map.containsValue(), map.remove(), map.size(), map.keySet(), map.values(), map.entrySet(), map.getOrDefault(), map.putIfAbsent(), map.computeIfAbsent(), map.forEach(), map.merge()'],
          ['set', 'Set<T> — set.add(), set.remove(), set.contains(), set.size(), set.isEmpty(), set.clear(), set.stream(), set.forEach(), set.iterator()'],
        ],
      },
      {
        group: '📦 Collections (static utilities)',
        rows: [
          ['Collections', 'java.util.Collections — Collections.sort(), .reverse(), .shuffle(), .min(), .max(), .frequency(), .unmodifiableList(), .synchronizedList(), .emptyList(), .singletonList(), .nCopies(), .disjoint(), .swap()'],
          ['Arrays', 'java.util.Arrays — Arrays.sort(), .binarySearch(), .copyOf(), .copyOfRange(), .fill(), .equals(), .deepEquals(), .toString(), .deepToString(), .asList(), .stream()'],
          ['List.of()', 'List.of(...) — immutable list factory (Java 9+)'],
          ['Map.of()', 'Map.of(k,v,...) — immutable map factory (Java 9+)'],
          ['Map.entry()', 'Map.entry(k,v) — immutable entry (Java 9+)'],
          ['Set.of()', 'Set.of(...) — immutable set factory (Java 9+)'],
        ],
      },
      // ─── Stream / Optional ─────────────────────────────────────────────
      {
        group: '🌊 Stream / Optional',
        rows: [
          ['stream', 'Stream<T> — stream.filter(), .map(), .flatMap(), .distinct(), .sorted(), .limit(), .skip(), .peek(), .reduce(), .count(), .findFirst(), .findAny(), .anyMatch(), .allMatch(), .noneMatch(), .collect(), .forEach(), .toArray(), .min(), .max()'],
          ['opt', 'Optional<T> / snippet — opt.isPresent(), opt.isEmpty(), opt.get(), opt.orElse(), opt.orElseGet(), opt.orElseThrow(), opt.map(), opt.flatMap(), opt.filter(), opt.ifPresent()'],
          ['Collectors', 'java.util.stream.Collectors — Collectors.toList(), .toSet(), .toMap(), .joining(), .groupingBy(), .partitioningBy(), .counting(), .summingInt(), .averagingInt(), .toUnmodifiableList()'],
          ['Optional.of()', 'Optional.of(x) / Optional.ofNullable(x) / Optional.empty()'],
          ['IntStream', 'IntStream.range(0,n) / IntStream.rangeClosed(a,b) — sum(), min(), max(), average(), boxed()'],
        ],
      },
      // ─── Exception ──────────────────────────────────────────────────────
      {
        group: '⚠️ Exception',
        rows: [
          ['ex', 'Exception/Throwable — ex.getMessage(), ex.getCause(), ex.getStackTrace(), ex.printStackTrace(), ex.getClass().getName(), ex.toString(), ex.initCause(), ex.getSuppressed()'],
          ['trycatch', 'try { } catch (ExType e) { } — full try-catch snippet'],
          ['tryfin', 'try { } catch { } finally { } — full try-finally snippet'],
          ['TryWithResources', 'try (Resource r = ...) { } — auto-close snippet'],
          ['CustomException', 'Custom exception class extending RuntimeException'],
        ],
      },
      // ─── IO / NIO ───────────────────────────────────────────────────────
      {
        group: '📁 IO / NIO (instances)',
        rows: [
          ['file', 'java.io.File — file.exists(), .getName(), .getPath(), .getAbsolutePath(), .isDirectory(), .isFile(), .length(), .listFiles(), .mkdirs(), .delete(), .renameTo(), .createNewFile(), .getParent(), .canRead(), .canWrite()'],
          ['path', 'java.nio.file.Path — path.getFileName(), .getParent(), .toAbsolutePath(), .toString(), .resolve(), .relativize(), .normalize(), .toFile(), .endsWith(), .startsWith()'],
          ['is', 'InputStream — is.read(), .read(byte[]), .readAllBytes(), .readNBytes(), .skip(), .available(), .close(), .mark(), .reset(), .transferTo()'],
          ['os', 'OutputStream — os.write(), .write(byte[]), .flush(), .close()'],
          ['br', 'BufferedReader — br.readLine(), .lines(), .read(), .close()'],
        ],
      },
      {
        group: '📁 IO / NIO (static utilities)',
        rows: [
          ['Files', 'java.nio.file.Files — Files.readAllLines(), .readAllBytes(), .readString(), .writeString(), .write(), .copy(), .move(), .delete(), .exists(), .createFile(), .createDirectory(), .createTempFile(), .walk(), .list(), .lines(), .size(), .isDirectory()'],
          ['Paths', 'java.nio.file.Paths — Paths.get(str) — path factory'],
          ['Path.of()', 'Path.of(str) — path factory (Java 11+)'],
          ['ReadFileLines', 'Snippet: read all lines from file'],
          ['WriteFile', 'Snippet: write string to file'],
          ['WalkDirectory', 'Snippet: walk directory tree with Files.walk()'],
        ],
      },
      // ─── Array ──────────────────────────────────────────────────────────
      {
        group: '🔢 Array (declarations)',
        rows: [
          ['int[]', 'int[] arr = new int[n];'],
          ['int[] inline', 'int[] arr = {1, 2, 3};'],
          ['String[]', 'String[] arr = new String[n];'],
          ['String[] inline', 'String[] arr = {"a", "b"};'],
          ['int[][]', 'int[][] matrix = new int[rows][cols];'],
          ['int[][] inline', '2D int array inline initializer'],
          ['Object[]', '$Type[] arr = new $Type[n];'],
          ['char[] from String', 'str.toCharArray() — and back'],
          ['byte[] from String', 'str.getBytes(UTF_8) — and back'],
        ],
      },
      {
        group: '🔢 Array (operations)',
        rows: [
          ['arr.length', 'arr.length — number of elements'],
          ['for array (index)', 'for (int i = 0; i < arr.length; i++)'],
          ['for array (enhanced)', 'for (Type x : arr)'],
          ['for 2D array', 'nested for loops over 2D array'],
          ['Find max in array', 'Find maximum value manually / via IntStream'],
          ['Find min in array', 'Find minimum value manually / via IntStream'],
          ['Sum array elements', 'Sum all elements manually / via IntStream.sum()'],
          ['Reverse array', 'Two-pointer in-place reverse'],
          ['Array to List and back', 'Arrays.asList() ↔ toArray()'],
          ['Flatten 2D array', 'Arrays.stream(arr).flatMapToInt(Arrays::stream).toArray()'],
          ['Array contains value', 'anyMatch() / Arrays.asList().contains()'],
          ['Remove duplicates from array', 'stream().distinct().toArray()'],
          ['Count occurrences in array', 'stream().filter().count()'],
          ['Array of random ints', 'IntStream.range().map(i -> rng.nextInt()).toArray()'],
        ],
      },
      // ─── System / Console / Scanner ─────────────────────────────────────
      {
        group: '🖥️ System.out / System.err / System',
        rows: [
          ['System.out.println()', 'Print line to stdout'],
          ['System.out.print()', 'Print without newline'],
          ['System.out.printf()', 'Formatted print (format string + args)'],
          ['System.out.format()', 'Alias for printf()'],
          ['System.out.flush()', 'Flush the output stream'],
          ['System.err.println()', 'Print error line to stderr'],
          ['System.err.printf()', 'Formatted error print'],
          ['System.exit(code)', 'Terminate JVM (0 = normal)'],
          ['System.currentTimeMillis()', 'Current time in ms since epoch'],
          ['System.nanoTime()', 'High-resolution time (for elapsed measurement)'],
          ['System.gc()', 'Hint JVM to run garbage collection'],
          ['System.getenv(key)', 'Read environment variable'],
          ['System.getProperty(key)', 'Read system property'],
          ['System.arraycopy(src,sPos,dst,dPos,len)', 'Fast native array copy'],
          ['System.lineSeparator()', 'OS-specific line separator'],
          ['sout', 'Shorthand → System.out.println()'],
          ['souf', 'Shorthand → System.out.printf()'],
          ['serr', 'Shorthand → System.err.println()'],
          ['PrintElapsed', 'Snippet: measure + print elapsed time with nanoTime()'],
        ],
      },
      {
        group: '📥 Scanner',
        rows: [
          ['ScannerStdin', 'Snippet: Scanner reading from System.in (keyboard)'],
          ['ScannerFile', 'Snippet: Scanner reading file line-by-line'],
          ['ScannerString', 'Snippet: Scanner reading from a String'],
          ['ScannerReadAllInts', 'Snippet: read all ints from stdin into a List'],
          ['scanner.next()', 'Read next whitespace-delimited token'],
          ['scanner.nextLine()', 'Read full line including spaces'],
          ['scanner.nextInt()', 'Read next int token'],
          ['scanner.nextLong()', 'Read next long token'],
          ['scanner.nextDouble()', 'Read next double token'],
          ['scanner.nextFloat()', 'Read next float token'],
          ['scanner.nextBoolean()', 'Read next boolean token'],
          ['scanner.hasNext()', 'True if more tokens available'],
          ['scanner.hasNextLine()', 'True if another line available'],
          ['scanner.hasNextInt()', 'True if next token is an int'],
          ['scanner.useDelimiter(pat)', 'Set custom delimiter pattern'],
          ['scanner.tokens()', 'Stream of tokens (Java 9+)'],
          ['scanner.close()', 'Close the Scanner'],
        ],
      },
      // ─── Thread / Concurrency ────────────────────────────────────────────
      {
        group: '🔀 Thread / Concurrency (instances)',
        rows: [
          ['thread', 'Thread — thread.start(), .join(), .interrupt(), .isAlive(), .isDaemon(), .setDaemon(), .getPriority(), .getState(), .getName(), .setName()'],
          ['Thread', 'Thread static — Thread.sleep(), .yield(), .currentThread(), .activeCount(), .interrupted(), .getAllStackTraces()'],
          ['executor', 'ExecutorService — executor.submit(), .execute(), .shutdown(), .shutdownNow(), .awaitTermination(), .isShutdown(), .isTerminated(), .invokeAll(), .invokeAny()'],
          ['Executors', 'Executors factory — Executors.newFixedThreadPool(), .newCachedThreadPool(), .newSingleThreadExecutor(), .newScheduledThreadPool()'],
          ['cf', 'CompletableFuture<T> instance — cf.thenApply(), .thenAccept(), .thenRun(), .exceptionally(), .get(), .join(), .complete(), .cancel(), .isDone()'],
          ['CompletableFuture', 'CompletableFuture static — CompletableFuture.supplyAsync(), .runAsync(), .allOf(), .anyOf()'],
          ['lock', 'ReentrantLock — lock.lock(), .unlock(), .tryLock(), .newCondition(), .isLocked()'],
          ['semaphore', 'Semaphore — semaphore.acquire(), .release(), .availablePermits(), .tryAcquire()'],
          ['countdown', 'CountDownLatch — countdown.await(), .countDown(), .getCount()'],
        ],
      },
      {
        group: '🔀 Thread / Concurrency (snippets)',
        rows: [
          ['ThreadRunnable', 'Snippet: new Thread(() -> { ... }).start()'],
          ['ExecutorSubmit', 'Snippet: executor.submit(Callable) + Future.get()'],
          ['CompletableFutureChain', 'Snippet: supplyAsync().thenApply().thenAccept().exceptionally()'],
          ['synchronized', 'Java keyword: synchronized block/method'],
        ],
      },
      // ─── Math / Numbers ─────────────────────────────────────────────────
      {
        group: '🔣 Math / Numbers',
        rows: [
          ['Math', 'java.lang.Math — Math.abs(), .ceil(), .floor(), .round(), .sqrt(), .pow(), .log(), .log10(), .exp(), .sin(), .cos(), .tan(), .PI, .E, .max(), .min(), .random(), .signum(), .hypot(), .atan2(), .toRadians(), .toDegrees()'],
          ['Integer', 'Integer — Integer.parseInt(), .valueOf(), .MAX_VALUE, .MIN_VALUE, .toBinaryString(), .toHexString(), .compare(), .bitCount(), .reverse(), .numberOfLeadingZeros(), .sum()'],
          ['Long', 'Long — Long.parseLong(), .valueOf(), .MAX_VALUE, .compare(), .toBinaryString(), .toHexString()'],
          ['Double', 'Double — Double.parseDouble(), .valueOf(), .isNaN(), .isInfinite(), .MAX_VALUE, .MIN_VALUE, .compare()'],
          ['Objects', 'java.util.Objects — Objects.requireNonNull(), .isNull(), .nonNull(), .toString(), .equals(), .hash(), .compare(), .requireNonNullElse(), .checkIndex()'],
        ],
      },
      // ─── Spring Boot Annotations ─────────────────────────────────────────
      {
        group: '🌱 Spring Boot Annotations',
        rows: [
          ['@SpringBootApplication', 'Entry point: @SpringBootApplication = @Configuration + @EnableAutoConfiguration + @ComponentScan'],
          ['@Configuration', 'Class declares @Bean factory methods'],
          ['@Bean', 'Method produces a Spring-managed bean'],
          ['@Component', 'Generic Spring-managed component'],
          ['@Service', 'Service layer stereotype'],
          ['@Repository', 'Data access layer stereotype (DAO)'],
          ['@RestController', '@Controller + @ResponseBody — returns JSON/XML directly'],
          ['@Controller', 'Spring MVC controller (returns view names)'],
          ['@Autowired', 'Inject dependency (field, constructor, or setter)'],
          ['@Qualifier', '@Qualifier("beanName") — disambiguate injection'],
          ['@Value', '@Value("${prop.key}") — inject property value'],
          ['@Primary', 'Mark bean as default when multiple candidates exist'],
          ['@Lazy', 'Initialize bean lazily on first use'],
          ['@Scope', '@Scope("prototype"/"request"/"session"/"singleton")'],
          ['@Profile', '@Profile("dev") — activate bean for named profile'],
          ['@PropertySource', '@PropertySource("classpath:app.properties")'],
          ['@ComponentScan', '@ComponentScan(basePackages="com.example")'],
          ['@EnableAutoConfiguration', 'Enable Spring Boot auto-configuration'],
          ['@Conditional', '@Conditional(SomeCondition.class)'],
          ['@ConditionalOnProperty', '@ConditionalOnProperty(name="key", havingValue="true")'],
          ['@ConditionalOnMissingBean', 'Create bean only when no bean of that type exists'],
          ['@EnableScheduling', 'Enable @Scheduled method execution'],
          ['@Scheduled', '@Scheduled(fixedRate=5000 / cron="0 * * * * *")'],
          ['@Async', 'Run method in a separate thread asynchronously'],
          ['@EnableAsync', 'Enable @Async support'],
          ['@EventListener', 'Listen to Spring ApplicationEvents'],
          ['@EnableTransactionManagement', 'Enable @Transactional annotation processing'],
          ['@Transactional', 'Wrap method in a database transaction'],
          ['@EnableJpaRepositories', 'Enable Spring Data JPA repositories'],
          ['@EnableCaching', 'Enable @Cacheable / @CacheEvict support'],
          ['@Cacheable', '@Cacheable("cacheName") — cache method result'],
          ['@CacheEvict', '@CacheEvict(value="name", allEntries=true)'],
          ['@CachePut', '@CachePut(value="name", key="#id")'],
        ],
      },
      // ─── Spring MVC Annotations ─────────────────────────────────────────
      {
        group: '🌐 Spring MVC Annotations',
        rows: [
          ['@RequestMapping', '@RequestMapping(value="/path", method=RequestMethod.GET)'],
          ['@GetMapping', '@GetMapping("/path") — HTTP GET handler'],
          ['@PostMapping', '@PostMapping("/path") — HTTP POST handler'],
          ['@PutMapping', '@PutMapping("/path") — HTTP PUT handler'],
          ['@DeleteMapping', '@DeleteMapping("/path") — HTTP DELETE handler'],
          ['@PatchMapping', '@PatchMapping("/path") — HTTP PATCH handler'],
          ['@RequestBody', 'Deserialize request body to object (JSON→Java)'],
          ['@ResponseBody', 'Serialize return value to response body'],
          ['@PathVariable', '@PathVariable("id") Long id — URI template variable'],
          ['@RequestParam', '@RequestParam(value="q", required=false) String q'],
          ['@RequestHeader', '@RequestHeader("Authorization") String token'],
          ['@ResponseStatus', '@ResponseStatus(HttpStatus.CREATED)'],
          ['@ExceptionHandler', '@ExceptionHandler(SomeException.class)'],
          ['@ControllerAdvice', 'Global exception handler class'],
          ['@RestControllerAdvice', '@ControllerAdvice + @ResponseBody'],
          ['@CrossOrigin', '@CrossOrigin(origins="http://localhost:3000")'],
          ['@Valid', 'Trigger Bean Validation on annotated parameter'],
          ['@Validated', 'Spring validation trigger (supports groups)'],
          ['@ModelAttribute', 'Bind request param/model data to method arg'],
          ['@SessionAttributes', 'Store model attributes in HttpSession between requests'],
          ['@SessionAttribute', 'Access a pre-existing session attribute'],
          ['@RequestAttribute', 'Access a request attribute set by Filter/Interceptor'],
          ['@CookieValue', '@CookieValue("JSESSIONID") String cookie'],
          ['@RequestPart', '@RequestPart("file") MultipartFile — multipart upload'],
          ['@InitBinder', 'Initialize WebDataBinder for form binding'],
          ['@EnableWebMvc', 'Enable full Spring MVC configuration from @Configuration'],
          ['@WebMvcTest', '@WebMvcTest(Controller.class) — slice test for web layer'],
          ['@AutoConfigureMockMvc', 'Auto-configure MockMvc for full-context tests'],
          ['@MockBean', 'Add Mockito mock to Spring application context'],
        ],
      },
      // ─── Spring MVC Types & Snippets ─────────────────────────────────────
      {
        group: '🌐 Spring MVC Types & Snippets',
        rows: [
          ['ResponseEntity', 'ResponseEntity.ok(body) — 200 OK with body'],
          ['ResponseEntityCreated', 'ResponseEntity.status(CREATED).body(body) — 201 Created'],
          ['ResponseEntityNotFound', 'ResponseEntity.notFound().build() — 404 Not Found'],
          ['HttpStatus', 'HttpStatus.OK / CREATED / NOT_FOUND / BAD_REQUEST / UNAUTHORIZED / FORBIDDEN / INTERNAL_SERVER_ERROR'],
          ['HttpHeaders', 'HttpHeaders — add()/set()/get()/getContentType()/setContentType()/setBearerAuth()'],
          ['MediaType', 'MediaType.APPLICATION_JSON / TEXT_HTML / MULTIPART_FORM_DATA / APPLICATION_OCTET_STREAM'],
          ['UriComponentsBuilder', 'Build URIs with template variables'],
          ['ModelAndView', 'Return view name + model data from @Controller'],
          ['Model', 'Add attributes to view model in @Controller methods'],
          ['RedirectAttributes', 'Pass flash attributes through redirect'],
          ['BindingResult', 'Holds validation errors — must follow @Valid parameter'],
          ['MultipartFile', 'MultipartFile.getOriginalFilename() / .getBytes() / .transferTo()'],
          ['HandlerInterceptor', 'preHandle() / postHandle() / afterCompletion() interface'],
          ['WebMvcConfigurer', 'Customize interceptors, CORS, resources, converters'],
          ['HttpServletRequest', 'req — see Jakarta Servlet section below'],
          ['HttpServletResponse', 'res — see Jakarta Servlet section below'],
          ['SpringController', 'Snippet: full @RestController class with CRUD methods'],
          ['SpringService', 'Snippet: full @Service class with repository injection'],
          ['SpringRepository', 'Snippet: full @Repository JpaRepository interface'],
          ['GlobalExceptionHandler', 'Snippet: @RestControllerAdvice with @ExceptionHandler'],
          ['CorsConfig', 'Snippet: @Configuration CORS mapping bean'],
          ['WebMvcConfigurer', 'Snippet: @EnableWebMvc configurer class'],
          ['HandlerInterceptor', 'Snippet: HandlerInterceptor implementation'],
          ['MockMvcTest', 'Snippet: @WebMvcTest + MockMvc test class'],
          ['MockMvcPerform', 'Snippet: mockMvc.perform(get/post/put/delete).andExpect()'],
          ['HttpHeadersBuilder', 'Snippet: build HttpHeaders with Auth + Content-Type'],
          ['ResponseEntity', 'Snippet: ResponseEntity.ok() / .created() / .notFound()'],
          ['ModelAndView', 'Snippet: ModelAndView with model attribute'],
          ['MultipartUpload', 'Snippet: MultipartFile upload handler'],
          ['RedirectFlash', 'Snippet: redirect with flash attribute'],
          ['BindingResultCheck', 'Snippet: @Valid + BindingResult error check'],
          ['UriCreated', 'Snippet: ServletUriComponentsBuilder.fromCurrentRequest()'],
          ['InitBinder', 'Snippet: @InitBinder WebDataBinder customizer'],
        ],
      },
      // ─── Spring Data ─────────────────────────────────────────────────────
      {
        group: '💾 Spring Data Repository Methods',
        rows: [
          ['findAll()', 'Return all entities — List<T>'],
          ['findById(id)', 'Return Optional<T> by primary key'],
          ['findAllById(ids)', 'Return Iterable<T> by collection of IDs'],
          ['save(entity)', 'Insert or update entity, returns saved entity'],
          ['saveAll(entities)', 'Save all entities in one batch'],
          ['saveAndFlush(entity)', 'Save and flush immediately to DB (JpaRepository)'],
          ['delete(entity)', 'Delete entity from DB'],
          ['deleteById(id)', 'Delete by primary key'],
          ['deleteAll()', 'Delete all entities'],
          ['count()', 'Return total count of entities'],
          ['existsById(id)', 'Return true if entity with ID exists'],
          ['flush()', 'Flush pending changes to DB (JpaRepository)'],
          ['findAll(Pageable)', 'Return Page<T> with pagination'],
          ['findAll(Sort)', 'Return sorted List<T>'],
          ['findByXxx(value)', 'Derived query — findByFieldName(value)'],
          ['findAllByXxx(value)', 'Derived find-all — findAllByFieldName(value)'],
          ['countByXxx(value)', 'Derived count — countByFieldName(value)'],
          ['existsByXxx(value)', 'Derived exists — existsByFieldName(value)'],
          ['deleteByXxx(value)', 'Derived delete — deleteByFieldName(value)'],
          ['PageRequest.of()', 'PageRequest.of(page, size, Sort.by("field"))'],
          ['@Query', '@Query("SELECT e FROM Entity e WHERE ...") — JPQL'],
          ['@Modifying', '@Modifying + @Transactional — for UPDATE/DELETE queries'],
        ],
      },
      // ─── Jakarta Servlet ─────────────────────────────────────────────────
      {
        group: '🌐 Jakarta Servlet',
        rows: [
          ['req', 'HttpServletRequest — req.getParameter(), .getHeader(), .getMethod(), .getRequestURI(), .getContextPath(), .getServletPath(), .getPathInfo(), .getRemoteAddr(), .getSession(), .getAttribute(), .setAttribute(), .getInputStream(), .getReader(), .getContentType(), .getCharacterEncoding(), .getCookies(), .getLocale(), .isSecure(), .getRequestURL()'],
          ['res', 'HttpServletResponse — res.setStatus(), .sendError(), .sendRedirect(), .setHeader(), .addHeader(), .setContentType(), .setCharacterEncoding(), .getWriter(), .getOutputStream(), .addCookie(), .flushBuffer(), .isCommitted()'],
          ['session', 'HttpSession — session.getAttribute(), .setAttribute(), .removeAttribute(), .getAttributeNames(), .getId(), .getCreationTime(), .getLastAccessedTime(), .setMaxInactiveInterval(), .invalidate(), .isNew()'],
          ['HttpServletRequestUsage', 'Snippet: extract common request info (URI, method, header, param, session)'],
        ],
      },
      // ─── Hibernate / JPA Annotations ─────────────────────────────────────
      {
        group: '🗃️ Hibernate / JPA Annotations',
        rows: [
          ['@Entity', 'Mark class as JPA entity mapped to DB table'],
          ['@Table', '@Table(name="table_name") — specify table name'],
          ['@Id', 'Mark field as primary key'],
          ['@GeneratedValue', '@GeneratedValue(strategy=GenerationType.IDENTITY/SEQUENCE/AUTO)'],
          ['@SequenceGenerator', 'Define a database sequence generator'],
          ['@Column', '@Column(name="col", nullable=false, length=255)'],
          ['@Basic', '@Basic(fetch=FetchType.EAGER/LAZY)'],
          ['@Lob', 'Map large object (CLOB / BLOB)'],
          ['@Temporal', '@Temporal(TemporalType.DATE/TIME/TIMESTAMP) — for java.util.Date'],
          ['@Transient', 'Exclude field from persistence (NOT transaction!)'],
          ['@Enumerated', '@Enumerated(EnumType.STRING/ORDINAL)'],
          ['@Embedded', 'Embed another @Embeddable class'],
          ['@Embeddable', 'Mark class as embeddable value type'],
          ['@EmbeddedId', 'Composite primary key using @Embeddable class'],
          ['@OneToOne', '@OneToOne(mappedBy="..", cascade=ALL, fetch=LAZY)'],
          ['@OneToMany', '@OneToMany(mappedBy="..", cascade=ALL, orphanRemoval=true)'],
          ['@ManyToOne', '@ManyToOne(fetch=FetchType.LAZY)'],
          ['@ManyToMany', '@ManyToMany(cascade={PERSIST, MERGE})'],
          ['@JoinColumn', '@JoinColumn(name="fk_col", nullable=false)'],
          ['@JoinTable', '@JoinTable(name="join_table", joinColumns=..., inverseJoinColumns=...)'],
          ['@NamedQuery', '@NamedQuery(name="Q.name", query="JPQL")'],
          ['@NamedNativeQuery', '@NamedNativeQuery(name="Q", query="SQL", resultClass=X.class)'],
          ['@Inheritance', '@Inheritance(strategy=InheritanceType.SINGLE_TABLE/JOINED/TABLE_PER_CLASS)'],
          ['@DiscriminatorColumn', '@DiscriminatorColumn(name="type", discriminatorType=STRING)'],
          ['@DiscriminatorValue', '@DiscriminatorValue("SUBTYPE")'],
          ['@MappedSuperclass', 'Superclass whose mapping applies to subclasses (not its own table)'],
          ['@DynamicInsert', 'Only include non-null columns in INSERT SQL (Hibernate)'],
          ['@DynamicUpdate', 'Only include changed columns in UPDATE SQL (Hibernate)'],
          ['@BatchSize', '@BatchSize(size=20) — batch fetch strategy'],
          ['@Cache', '@Cache(usage=CacheConcurrencyStrategy.READ_WRITE) — L2 cache'],
          ['@NaturalId', 'Declare a natural (business) identifier'],
          ['@CreationTimestamp', 'Auto-set field on INSERT (Hibernate)'],
          ['@UpdateTimestamp', 'Auto-update field on UPDATE (Hibernate)'],
          ['@Formula', '@Formula("SQL expression") — derived/computed field'],
          ['@Where', '@Where(clause="deleted=0") — soft-delete filter'],
          ['@SoftDelete', 'Hibernate 6.4+ soft-delete support'],
          ['@Type', '@Type(value=CustomType.class) — custom Hibernate type'],
        ],
      },
      // ─── Hibernate / JPA Methods (EntityManager, Session) ────────────────
      {
        group: '🗃️ Hibernate / JPA Methods',
        rows: [
          ['em', 'EntityManager — em.persist(), .merge(), .remove(), .find(), .getReference(), .createQuery(), .createNativeQuery(), .createNamedQuery(), .flush(), .clear(), .contains(), .detach(), .refresh(), .lock(), .getCriteriaBuilder(), .getEntityManagerFactory()'],
          ['query', 'TypedQuery/Query — query.getResultList(), .getSingleResult(), .executeUpdate(), .setParameter(), .setFirstResult(), .setMaxResults(), .setHint(), .getResultStream()'],
          ['cb', 'CriteriaBuilder — cb.createQuery(), .equal(), .notEqual(), .like(), .greaterThan(), .lessThan(), .between(), .and(), .or(), .not(), .in(), .isNull(), .isNotNull(), .upper(), .lower(), .count(), .sum(), .avg(), .max(), .min(), .asc(), .desc(), .parameter()'],
          ['root', 'Root<T> (Criteria) — root.get(), .join(), .fetch(), .type()'],
          ['session', 'Hibernate Session — session.get(), .load(), .save(), .saveOrUpdate(), .update(), .delete(), .merge(), .persist(), .evict(), .flush(), .clear(), .contains(), .createQuery(), .createNativeQuery(), .beginTransaction()'],
          ['EntityManager', 'Snippet: entityManager.createQuery().setParameter().getResultList()'],
          ['CriteriaBuilder', 'Snippet: full Criteria API query with Root, Where, Select'],
          ['JpaEntity', 'Snippet: full @Entity class with @Id, @Column, @CreationTimestamp, Lombok'],
        ],
      },
      // ─── Lombok ──────────────────────────────────────────────────────────
      {
        group: '🔧 Lombok Annotations',
        rows: [
          ['@Getter', 'Generate getXxx() for all fields'],
          ['@Setter', 'Generate setXxx() for all non-final fields'],
          ['@ToString', 'Generate toString() with all fields'],
          ['@EqualsAndHashCode', 'Generate equals() + hashCode()'],
          ['@NoArgsConstructor', 'Generate no-argument constructor'],
          ['@AllArgsConstructor', 'Generate all-argument constructor'],
          ['@RequiredArgsConstructor', 'Generate constructor for final / @NonNull fields'],
          ['@Data', '@Getter + @Setter + @ToString + @EqualsAndHashCode + @RequiredArgsConstructor'],
          ['@Builder', 'Implement Builder pattern for the class'],
          ['@SuperBuilder', 'Builder pattern with inheritance support'],
          ['@Value', 'Immutable @Data (all fields private final)'],
          ['@Slf4j', 'Inject SLF4J logger: private static final Logger log'],
          ['@Log4j2', 'Inject Log4j2 logger'],
          ['@NonNull', 'Null-check + throw NullPointerException if null'],
          ['@SneakyThrows', 'Throw checked exception without declaring in throws'],
          ['@Synchronized', 'Synchronized method (safer than synchronized keyword)'],
          ['@With', 'Generate wither methods (immutable copy-with)'],
          ['@Cleanup', 'Auto-close resource (like try-with-resources)'],
          ['@FieldDefaults', '@FieldDefaults(level=AccessLevel.PRIVATE)'],
        ],
      },
      // ─── Bean Validation ─────────────────────────────────────────────────
      {
        group: '✅ Bean Validation Annotations',
        rows: [
          ['@NotNull', 'Field must not be null'],
          ['@NotBlank', 'String must not be blank (not null, not empty, not whitespace)'],
          ['@NotEmpty', 'Collection / String / Array must not be empty'],
          ['@Size', '@Size(min=1, max=255) — size must be within bounds'],
          ['@Min', '@Min(0) — number must be >= value'],
          ['@Max', '@Max(100) — number must be <= value'],
          ['@Positive', 'Number must be > 0'],
          ['@PositiveOrZero', 'Number must be >= 0'],
          ['@Negative', 'Number must be < 0'],
          ['@Email', 'String must be a valid email address'],
          ['@Pattern', '@Pattern(regexp="[A-Z]+") — must match regex'],
          ['@Past', 'Date must be in the past'],
          ['@Future', 'Date must be in the future'],
          ['@PastOrPresent', 'Date must be in the past or present'],
          ['@FutureOrPresent', 'Date must be in the future or present'],
          ['@DecimalMin', '@DecimalMin("0.0") — decimal >= value'],
          ['@DecimalMax', '@DecimalMax("999.99") — decimal <= value'],
          ['@Digits', '@Digits(integer=6, fraction=2) — limit integer/fraction digits'],
          ['@AssertTrue', 'Boolean must be true'],
          ['@AssertFalse', 'Boolean must be false'],
        ],
      },
      // ─── JDBC ────────────────────────────────────────────────────────────
      {
        group: '🗄️ JDBC (instances)',
        rows: [
          ['DriverManager', 'DriverManager.getConnection(url, user, pass) — Class.forName("driver")'],
          ['conn', 'Connection — conn.createStatement(), .prepareStatement(), .prepareCall(), .setAutoCommit(), .commit(), .rollback(), .setSavepoint(), .close(), .isClosed(), .isValid(), .setTransactionIsolation(), .getMetaData()'],
          ['stmt', 'Statement — stmt.executeQuery(), .executeUpdate(), .execute(), .executeBatch(), .addBatch(), .getGeneratedKeys(), .setMaxRows(), .setQueryTimeout(), .setFetchSize(), .cancel(), .close()'],
          ['ps', 'PreparedStatement — ps.setInt/Long/Double/Boolean/String/Date/Timestamp/BigDecimal/Null/Object/Bytes/Blob(), .clearParameters(), .executeQuery(), .executeUpdate(), .addBatch()'],
          ['rs', 'ResultSet — rs.next(), .previous(), .first(), .last(), .absolute(), rs.getInt/Long/Double/Boolean/String/Date/Timestamp/BigDecimal/Object/Bytes/Blob(col), .wasNull(), .getMetaData(), .getRow(), .close()'],
          ['rsmd', 'ResultSetMetaData — rsmd.getColumnCount(), .getColumnName(), .getColumnLabel(), .getColumnType(), .getColumnTypeName(), .isNullable()'],
          ['dbmd', 'DatabaseMetaData — dbmd.getTables(), .getColumns(), .getPrimaryKeys(), .getDatabaseProductName(), .getDriverName(), .supportsTransactions()'],
          ['cs', 'CallableStatement — cs.registerOutParameter(index, Types.INTEGER/VARCHAR/...)'],
        ],
      },
      {
        group: '🗄️ JDBC Snippets',
        rows: [
          ['JDBC Connect', 'Full DriverManager.getConnection() with try-with-resources'],
          ['JDBC Select Query', 'PreparedStatement SELECT with ResultSet iteration'],
          ['JDBC Insert', 'INSERT with auto-generated key retrieval'],
          ['JDBC Update', 'UPDATE with parameter binding'],
          ['JDBC Delete', 'DELETE by ID'],
          ['JDBC Transaction', 'Manual setAutoCommit(false) / commit() / rollback() block'],
          ['JDBC Batch Insert', 'addBatch() / executeBatch() inside transaction'],
          ['JDBC Stored Procedure', 'CallableStatement with IN + OUT parameters'],
          ['JDBC ResultSet to List', 'Map all rows to List of entity objects'],
          ['JDBC DataSource HikariCP', 'HikariConfig + HikariDataSource connection pool'],
          ['JDBC Spring JdbcTemplate Query', 'jdbcTemplate.query() with RowMapper lambda'],
          ['JDBC Spring JdbcTemplate Update', 'jdbcTemplate.update() for INSERT/UPDATE/DELETE'],
        ],
      },
      // ─── Date & Time ─────────────────────────────────────────────────────
      {
        group: '📅 Date & Time — java.util (Legacy)',
        rows: [
          ['date', 'java.util.Date — date.getTime(), .setTime(), .before(), .after(), .compareTo(), .toInstant() | Date.from(instant)'],
          ['cal', 'Calendar — Calendar.getInstance() | cal.get(Calendar.YEAR/MONTH/DAY_OF_MONTH), .set(), .add(), .getTime(), .setTime(), .getTimeInMillis(), .before(), .after(), .toInstant()'],
          ['java.sql.Date.valueOf(ld)', 'Convert LocalDate → java.sql.Date for JDBC binding'],
          ['java.sql.Timestamp.valueOf(ldt)', 'Convert LocalDateTime → Timestamp for JDBC binding'],
          ['timestamp.toLocalDateTime()', 'Convert Timestamp → LocalDateTime from JDBC ResultSet'],
          ['sqlDate.toLocalDate()', 'Convert java.sql.Date → LocalDate from JDBC ResultSet'],
        ],
      },
      {
        group: '📅 Date & Time — java.time (Modern API)',
        rows: [
          ['LocalDate', 'LocalDate.now() / .of(y,m,d) / .parse(str) / .ofEpochDay(n)'],
          ['ld', 'LocalDate instance — ld.plusDays/Weeks/Months/Years(), .minusDays/Months/Years(), .getYear(), .getMonthValue(), .getDayOfMonth(), .getDayOfWeek(), .isLeapYear(), .isBefore/isAfter/isEqual(), .atStartOfDay(), .format(formatter), .withYear/Month/Day(), .toEpochDay(), .until()'],
          ['LocalTime', 'LocalTime.now() / .of(h,m,s) / .parse(str) / .MIDNIGHT / .NOON'],
          ['lt', 'LocalTime instance — lt.getHour/Minute/Second/Nano(), .plusHours/Minutes/Seconds(), .minusHours/Minutes(), .isBefore/isAfter(), .format(), .atDate(), .toSecondOfDay()'],
          ['LocalDateTime', 'LocalDateTime.now() / .of(y,m,d,h,mi) / .of(date,time) / .parse(str) / .ofInstant(i,z)'],
          ['ldt', 'LocalDateTime instance — ldt.toLocalDate/Time(), .plusDays/Hours/Minutes/Months/Seconds(), .minusDays/Hours/Months(), .isBefore/isAfter/isEqual(), .format(), .atZone(), .toInstant(), .withYear/Month/Day/Hour/Minute(), .truncatedTo()'],
          ['ZonedDateTime', 'ZonedDateTime.now() / .now(zone) / .of(ldt,zone) / .parse(str) / .ofInstant(i,zone)'],
          ['zdt', 'ZonedDateTime instance — zdt.toLocalDateTime/Date(), .toInstant(), .getZone(), .withZoneSameInstant(), .format()'],
          ['OffsetDateTime', 'OffsetDateTime.now() / .of(ldt,offset) / .parse(str)'],
          ['odt', 'OffsetDateTime instance — odt.toInstant(), .toZonedDateTime(), .getOffset()'],
          ['Instant', 'Instant.now() / .ofEpochMilli(ms) / .ofEpochSecond(s) / .parse(str) / .EPOCH'],
          ['instant', 'Instant instance — instant.toEpochMilli(), .getEpochSecond(), .plusMillis/Seconds(), .minusMillis(), .isBefore/isAfter(), .atZone(), .atOffset()'],
          ['Duration', 'Duration.between(s,e) / .ofDays/Hours/Minutes/Seconds/Millis/Nanos(n) / .parse(str)'],
          ['dur', 'Duration instance — dur.toDays/Hours/Minutes/Seconds/Millis/Nanos(), .isNegative/Zero(), .abs(), .negated(), .multipliedBy(), .dividedBy()'],
          ['Period', 'Period.between(s,e) / .of(y,m,d) / .ofDays/Months/Years(n)'],
          ['period', 'Period instance — period.getYears/Months/Days(), .toTotalMonths(), .isNegative/Zero(), .negated(), .normalized(), .plusYears/Months/Days()'],
          ['DateTimeFormatter', 'DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss") / ISO_LOCAL_DATE / ISO_LOCAL_DATE_TIME / ISO_INSTANT / RFC_1123_DATE_TIME'],
          ['fmt', 'DateTimeFormatter instance — fmt.format(temporal), .parse(text), .withLocale(), .withZone()'],
          ['ZoneId', 'ZoneId.of("Asia/Ho_Chi_Minh") / ZoneId.systemDefault() / ZoneId.getAvailableZoneIds()'],
          ['ZoneOffset', 'ZoneOffset.UTC / .of("+07:00") / .ofHours(7)'],
          ['YearMonth', 'YearMonth.now() / .of(y,m) | ym.isLeapYear(), .lengthOfMonth(), .atDay(d), .atEndOfMonth()'],
          ['ChronoUnit', 'ChronoUnit.DAYS/MONTHS/YEARS/HOURS/MINUTES.between(start, end)'],
        ],
      },
      {
        group: '📅 Date & Time Snippets',
        rows: [
          ['FormatLocalDateTime', 'Format LocalDateTime.now() with a custom pattern'],
          ['ParseToLocalDate', 'Parse date string to LocalDate using formatter'],
          ['DaysBetween', 'ChronoUnit.DAYS.between(start, end)'],
          ['AgeCalculator', 'Period.between(birthDate, today) → years, months, days'],
          ['ConvertLegacyDateToLocalDate', 'java.util.Date ↔ LocalDate bidirectional conversion'],
          ['TimestampToLocalDateTime', 'java.sql.Timestamp ↔ LocalDateTime (JDBC)'],
          ['MeasureElapsedInstant', 'Instant.now() + Duration.between() to measure elapsed time'],
          ['ZonedDateTimeConvert', 'Convert LocalDateTime to multiple time zones'],
          ['SpringDataCreatedAt', '@CreatedDate / @LastModifiedDate JPA audit fields'],
          ['DateRangeCheck', 'Check if today is within a date range (inclusive)'],
        ],
      },
      // ─── Frontend: HTML / Bootstrap 5 ────────────────────────────────────
      {
        group: '🌐 HTML5 Structural Snippets',
        rows: [
          ['html5', 'Full HTML5 boilerplate (<!DOCTYPE html> + head + body)'],
          ['html5-bootstrap', 'HTML5 + Bootstrap 5 CDN (CSS + JS bundle)'],
          ['meta:viewport', '<meta name="viewport" content="width=device-width, initial-scale=1.0">'],
          ['meta:charset', '<meta charset="UTF-8">'],
          ['meta:og', 'Open Graph meta tags (og:title, og:description, og:image)'],
          ['link:css', '<link rel="stylesheet" href="styles.css">'],
          ['link:favicon', '<link rel="icon" ...>'],
          ['script:src', '<script src="script.js"></script>'],
          ['script:defer', '<script defer src="..."></script>'],
          ['script:module', '<script type="module" src="..."></script>'],
          ['header', '<header>...</header>'],
          ['nav', '<nav>...</nav>'],
          ['main', '<main>...</main>'],
          ['footer', '<footer>...</footer>'],
          ['section', '<section><h2>Title</h2>...</section>'],
          ['article', '<article><h2>Title</h2>...</article>'],
          ['aside', '<aside>...</aside>'],
          ['figure', '<figure><img><figcaption>...</figcaption></figure>'],
          ['details', '<details><summary>...</summary>...</details>'],
          ['dialog', 'Native HTML <dialog> element'],
          ['div', '<div class="...">...</div>'],
          ['span', '<span class="...">text</span>'],
          ['a', '<a href="#" target="_blank">Link text</a>'],
          ['a:blank', 'External link with rel="noopener noreferrer"'],
          ['h1', '<h1>Heading 1</h1>'],
          ['h2', '<h2>Heading 2</h2>'],
          ['h3', '<h3>Heading 3</h3>'],
          ['p', '<p>Paragraph.</p>'],
        ],
      },
      {
        group: '📋 HTML Form Snippets',
        rows: [
          ['form', '<form action method id> ... <button type="submit">'],
          ['input:text', '<input type="text" id name placeholder required>'],
          ['input:email', '<input type="email"> — email field'],
          ['input:password', '<input type="password"> — password field'],
          ['input:number', '<input type="number" min max value>'],
          ['input:date', '<input type="date"> — date picker'],
          ['input:file', '<input type="file" accept>'],
          ['input:checkbox', '<input type="checkbox">'],
          ['input:radio', '<input type="radio"> + <label>'],
          ['input:hidden', '<input type="hidden">'],
          ['input:search', '<input type="search"> — search input'],
          ['input:range', '<input type="range" min max> — slider'],
          ['input:color', '<input type="color"> — color picker'],
          ['label', '<label for="id">Label text</label>'],
          ['textarea', '<textarea rows cols placeholder>'],
          ['select', '<select> with <option> list'],
          ['datalist', '<input list> + <datalist> autocomplete'],
          ['fieldset', '<fieldset><legend>...</legend>...</fieldset>'],
          ['button', '<button type="button" id>Click Me</button>'],
          ['button:submit', '<button type="submit">Submit</button>'],
        ],
      },
      {
        group: '📊 HTML Table & List Snippets',
        rows: [
          ['table', '<table><thead><tr><th>...</th></tr></thead><tbody>...</tbody></table>'],
          ['table:full', 'Table with caption, thead, tbody, tfoot'],
          ['tr', '<tr><td>...</td></tr>'],
          ['ul', '<ul><li>...</li></ul> — bullet list'],
          ['ol', '<ol><li>...</li></ol> — numbered list'],
          ['li', '<li>Item</li>'],
          ['dl', '<dl><dt>Term</dt><dd>Definition</dd></dl>'],
        ],
      },
      {
        group: '🎬 HTML Media & Embed',
        rows: [
          ['img', '<img src alt width height>'],
          ['img:responsive', '<img class="img-fluid"> — Bootstrap responsive'],
          ['picture', '<picture><source media><img></picture>'],
          ['video', '<video controls><source src type></video>'],
          ['audio', '<audio controls><source src type></audio>'],
          ['iframe', '<iframe src width height frameborder allowfullscreen>'],
          ['iframe:youtube', 'YouTube embed iframe'],
          ['canvas', '<canvas id width height>'],
          ['svg', 'Inline SVG with xmlns, width, height, viewBox'],
        ],
      },
      // ─── Frontend: Bootstrap 5 Layout ────────────────────────────────────
      {
        group: '📐 Bootstrap 5 — Layout Snippets',
        rows: [
          ['container', '<div class="container">'],
          ['container-fluid', '<div class="container-fluid">'],
          ['row', '<div class="row">'],
          ['col', '<div class="col">'],
          ['col-md', '<div class="col-12 col-md-{n}">'],
          ['col-layout-2', '2-column responsive row (col-12 col-md-6)'],
          ['col-layout-3', '3-column responsive row (col-12 col-md-4)'],
          ['col-layout-sidebar', 'Sidebar (col-md-3) + Main (col-md-9) layout'],
        ],
      },
      // ─── Frontend: Bootstrap 5 Components ────────────────────────────────
      {
        group: '🧩 Bootstrap 5 — Component Snippets',
        rows: [
          ['navbar', 'Responsive navbar with brand, toggler, nav links'],
          ['card', 'Card with image, title, text, button'],
          ['card-simple', 'Card with header, body, footer'],
          ['card-group', 'Row of cards with equal height'],
          ['modal', 'Modal with trigger button, header, body, footer'],
          ['alert', 'Dismissible alert (alert-success/danger/warning...)'],
          ['btn', '<button class="btn btn-primary">'],
          ['btn-group', 'Button group'],
          ['badge', '<span class="badge bg-primary">'],
          ['breadcrumb', 'Breadcrumb nav'],
          ['pagination', 'Pagination nav with page items'],
          ['accordion', 'Accordion with collapse items'],
          ['tabs', 'Nav tabs + tab-content panes'],
          ['dropdown', 'Dropdown button with menu items'],
          ['form-bs', 'Bootstrap 5 styled form with mb-3, form-control'],
          ['form-floating', 'Floating label input'],
          ['input-group', 'Input group with addon text'],
          ['form-check', 'Bootstrap checkbox / radio with form-check'],
          ['form-select', 'Bootstrap styled <select class="form-select">'],
          ['table-bs', 'Responsive, striped, hover Bootstrap table'],
          ['spinner', 'spinner-border loading indicator'],
          ['progress', 'Progress bar with aria attributes'],
          ['toast', 'Toast notification (position-fixed)'],
          ['offcanvas', 'Offcanvas sliding panel'],
          ['hero', 'Hero / jumbotron section'],
          ['list-group', 'Vertical list group'],
          ['carousel', 'Image carousel with controls'],
        ],
      },
      // ─── Frontend: Bootstrap 5 Utility Classes ────────────────────────────
      {
        group: '🎨 Bootstrap 5 — Utility Classes (gõ tên class)',
        rows: [
          ['d-flex / d-grid / d-none / d-block', 'Display utilities'],
          ['justify-content-{start|end|center|between|evenly}', 'Flex justify-content'],
          ['align-items-{start|end|center|stretch}', 'Flex align-items'],
          ['flex-{row|column|wrap|nowrap|grow-1|shrink-0}', 'Flex direction/wrap'],
          ['gap-{0..5} / gx-{n} / gy-{n}', 'Gap utilities'],
          ['ms-auto / me-auto / mx-auto', 'Margin auto (flex centering)'],
          ['vstack / hstack', 'Vertical / horizontal stack'],
          ['m-{0..5} / mb/mt/ms/me/mx/my-{n}', 'Margin utilities'],
          ['p-{0..5} / pb/pt/ps/pe/px/py-{n}', 'Padding utilities'],
          ['text-{start|center|end}', 'Text alignment'],
          ['text-{primary|secondary|success|danger|warning|info|muted|white|dark}', 'Text colors'],
          ['fw-{bold|normal|light|semibold} / fst-italic', 'Font weight / style'],
          ['fs-{1..6}', 'Font size (2.5rem → 1rem)'],
          ['display-{1..6}', 'Display headings (5rem → 2.5rem)'],
          ['lead', 'Larger lead paragraph'],
          ['text-truncate / text-nowrap / text-uppercase / text-decoration-none', 'Text utilities'],
          ['bg-{primary|secondary|success|danger|warning|info|light|dark|white}', 'Background colors'],
          ['bg-gradient / bg-opacity-{25|50|75}', 'Gradient + opacity'],
          ['border / border-{0|top|bottom|primary|danger}', 'Border utilities'],
          ['border-{1|2|3}', 'Border width'],
          ['rounded / rounded-{0|3|4|5|circle|pill}', 'Border radius'],
          ['shadow / shadow-{sm|lg|none}', 'Box shadows'],
          ['w-{25|50|75|100|auto} / h-{25|50|75|100}', 'Width / height utilities'],
          ['min-vh-100 / vh-100 / mw-100', 'Viewport height / max-width'],
          ['position-{relative|absolute|fixed|sticky}', 'Position utilities'],
          ['top-0 / bottom-0 / start-0 / end-0 / top-50 / start-50', 'Position offset'],
          ['translate-middle', 'Center with translate(-50%, -50%)'],
          ['overflow-{auto|hidden|scroll}', 'Overflow utilities'],
          ['visible / invisible / visually-hidden', 'Visibility utilities'],
          ['z-{0|1|2|n1}', 'Z-index utilities'],
          ['object-fit-{cover|contain}', 'Object-fit utilities'],
          ['img-fluid / img-thumbnail', 'Responsive / thumbnail image'],
          ['btn / btn-{color} / btn-outline-{color}', 'Button variants'],
          ['btn-{sm|lg} / btn-close', 'Button size / close button'],
          ['nav-link / nav-tabs / nav-pills', 'Nav link styles'],
          ['table / table-{striped|hover|bordered|responsive|dark|sm}', 'Table utilities'],
          ['form-control / form-label / form-text', 'Form input styling'],
          ['is-valid / is-invalid / valid-feedback / invalid-feedback', 'Form validation styles'],
          ['ratio-{16x9|4x3|1x1}', 'Aspect ratio'],
          ['stretched-link / pe-none / user-select-none', 'Misc utilities'],
          ['float-{start|end} / clearfix', 'Float utilities'],
        ],
      },
      // ─── Frontend: CSS Snippets ───────────────────────────────────────────
      {
        group: '🎨 CSS — Layout Snippets',
        rows: [
          ['flex-center', '.container { display:flex; justify-content:center; align-items:center; }'],
          ['flex-column', 'Flex column layout'],
          ['flex-row', 'Flex row layout with gap'],
          ['flex-space-between', 'Flex justify-content:space-between'],
          ['flex-wrap', 'Flex with flex-wrap:wrap + gap'],
          ['grid-2col', 'display:grid; grid-template-columns: repeat(2, 1fr)'],
          ['grid-3col', '3-column CSS Grid'],
          ['grid-auto', 'Auto-fit responsive grid (minmax)'],
          ['grid-layout', 'Named grid areas (header/sidebar/main/footer)'],
          ['grid-place-center', 'display:grid; place-items:center'],
          ['position-center', 'Absolute center trick (top:50% + transform:-50%)'],
          ['sticky-header', 'position:sticky; top:0 with shadow'],
          ['truncate', 'Single-line text ellipsis (white-space:nowrap + overflow:hidden)'],
          ['multiline-clamp', '-webkit-line-clamp: N lines'],
          ['reset-css', '*, *::before, *::after { box-sizing:border-box; margin:0; padding:0 }'],
          ['visually-hidden', 'Screen-reader only utility class'],
          ['scrollbar-hidden', 'Hide scrollbar cross-browser'],
        ],
      },
      {
        group: '✨ CSS — Animation Snippets',
        rows: [
          ['@keyframes', '@keyframes name { from {...} to {...} }'],
          ['@keyframes-steps', '@keyframes with 0%, 50%, 100% steps'],
          ['animation', 'animation: name duration easing iteration'],
          ['transition', 'transition: property duration easing'],
          ['transition-multiple', 'Multiple CSS transitions (opacity + transform)'],
          ['hover-lift', ':hover { transform:translateY(-4px); box-shadow:... }'],
          ['fade-in', '@keyframes fadeIn + animation'],
          ['slide-in-left', '@keyframes slideInLeft + animation'],
          ['spin', 'Infinite spin for loader'],
          ['transform-rotate', 'transform: rotate(45deg)'],
          ['transform-scale', 'transform: scale(1.2)'],
          ['transform-translate', 'transform: translateX(0) translateY(0)'],
        ],
      },
      {
        group: '📱 CSS — Media Query Snippets',
        rows: [
          ['@media-sm', '@media (max-width: 576px) { } — mobile'],
          ['@media-md', '@media (max-width: 768px) { } — tablet'],
          ['@media-lg', '@media (max-width: 992px) { } — small desktop'],
          ['@media-xl', '@media (max-width: 1200px) { } — desktop'],
          ['@media-min-md', '@media (min-width: 768px) { } — tablet+'],
          ['@media-min-lg', '@media (min-width: 992px) { } — desktop+'],
          ['@media-dark', '@media (prefers-color-scheme: dark) { }'],
          ['@media-print', '@media print { }'],
          ['@media-landscape', '@media (orientation: landscape) { }'],
          ['@media-hover', '@media (hover: hover) { .el:hover { } }'],
        ],
      },
      {
        group: '🎨 CSS — Other Snippets',
        rows: [
          [':root-vars', ':root { --primary:#007bff; --font-size:16px; ... }'],
          ['var()', 'var(--variableName) — use CSS custom property'],
          ['var-fallback', 'var(--name, fallback)'],
          ['color-scheme', ':root {} + [data-theme="dark"] {} — light/dark vars'],
          [':hover', '.el:hover { }'],
          [':focus', '.el:focus { outline:2px solid ... }'],
          ['::before / ::after', 'Pseudo-elements with content'],
          ['::placeholder', 'Input placeholder styling'],
          [':nth-child / :not() / :is() / :where()', 'CSS selector helpers'],
          ['bg-gradient-linear', 'background: linear-gradient(135deg, ...)'],
          ['bg-gradient-radial', 'background: radial-gradient(circle, ...)'],
          ['box-shadow-card', 'Card-style multi-layer box shadow'],
          ['text-gradient', 'Gradient colored text via background-clip'],
          ['glassmorphism', 'Glass effect: rgba bg + backdrop-filter:blur'],
          ['aspect-ratio', 'aspect-ratio: 16 / 9'],
          ['font-import', '@import url(Google Fonts)'],
          ['font-face', '@font-face { font-family, src woff2/woff, font-display:swap }'],
        ],
      },
      // ─── Frontend: JavaScript ─────────────────────────────────────────────
      {
        group: '🟨 JavaScript — DOM Snippets',
        rows: [
          ['qsel', 'document.querySelector("#id")'],
          ['qsel-all', 'document.querySelectorAll(".class")'],
          ['getById / getByClass / getByTag', 'getElementById / getElementsByClassName / Tag'],
          ['createElement', 'create + className + textContent + appendChild'],
          ['innerHTML / textContent', 'Set element content'],
          ['setAttribute / getAttribute / removeAttribute', 'Element attributes'],
          ['classList-add / remove / toggle / contains', 'CSS class manipulation'],
          ['style-set', 'element.style.property = value'],
          ['dataset / dataset-set', 'element.dataset.key — read/write data attributes'],
          ['appendChild / removeChild / remove', 'DOM tree mutation'],
          ['insertBefore / insertAdjacentHTML', 'Insert elements'],
          ['cloneNode / closest / matches', 'Clone, traverse, test'],
          ['getBoundingClientRect', 'Get element position and size'],
          ['scrollIntoView', 'Smooth scroll to element'],
          ['querySelectorAll-forEach', 'querySelectorAll + .forEach()'],
          ['dom-ready', 'document.addEventListener("DOMContentLoaded", ...)'],
          ['window-load', 'window.addEventListener("load", ...)'],
        ],
      },
      {
        group: '🟨 JavaScript — Event Snippets',
        rows: [
          ['addEventListener', 'element.addEventListener("click", function(event) { })'],
          ['addEventListener-arrow', 'addEventListener with arrow function'],
          ['removeEventListener', 'element.removeEventListener(event, handler)'],
          ['event-delegation', 'Parent listens → event.target.matches(".item")'],
          ['preventDefault', 'event.preventDefault()'],
          ['stopPropagation', 'event.stopPropagation()'],
          ['input-change', 'listen for input value changes'],
          ['form-submit', 'preventDefault + FormData'],
          ['keyboard-event', 'keydown → e.key check'],
          ['scroll-event', 'window.scrollY'],
          ['resize-event', 'window.innerWidth / innerHeight'],
          ['custom-event', 'new CustomEvent() + dispatchEvent()'],
          ['once-event', 'addEventListener with { once: true }'],
          ['passive-event', 'addEventListener with { passive: true }'],
        ],
      },
      {
        group: '🟨 JavaScript — Fetch / Async Snippets',
        rows: [
          ['fetch-get', 'fetch(url).then().then().catch() — GET'],
          ['fetch-async', 'async/await GET with try/catch'],
          ['fetch-post', 'fetch with method:POST, headers, JSON.stringify(body)'],
          ['fetch-post-async', 'async POST function'],
          ['fetch-put / fetch-delete', 'PUT / DELETE requests'],
          ['fetch-headers', 'Headers with Authorization Bearer token'],
          ['fetch-abort', 'AbortController + setTimeout abort'],
          ['Promise-new', 'new Promise((resolve, reject) => { })'],
          ['Promise-all', 'await Promise.all([p1, p2])'],
          ['Promise-allSettled', 'await Promise.allSettled(...)'],
          ['async-function', 'async function with try/catch'],
          ['try-catch', 'try { } catch (error) { } finally { }'],
        ],
      },
      {
        group: '🟨 JavaScript — Storage & Patterns',
        rows: [
          ['ls-set / ls-get / ls-remove / ls-clear', 'localStorage CRUD'],
          ['ls-json-set / ls-json-get', 'localStorage with JSON.stringify/parse'],
          ['ss-set / ss-get / ss-remove', 'sessionStorage CRUD'],
          ['cookie-set / cookie-get', 'Document cookie set/get'],
          ['setTimeout / setInterval / clearTimeout / clearInterval', 'Timing functions'],
          ['requestAnimationFrame', 'rAF animation loop'],
          ['class', 'ES6 class with constructor + method'],
          ['export-default / export-named / import', 'ES modules'],
          ['destructure-obj / destructure-arr', 'Destructuring assignment'],
          ['spread-obj / spread-arr', 'Spread operator for merge/clone'],
          ['for-of / for-in / for-entries', 'Modern loop patterns'],
          ['ternary / nullish / optional-chain', 'Modern operators'],
          ['cl / ce / ct / cw', 'console.log/error/table/warn'],
          ['Array-map / filter / reduce / find / flat', 'Array higher-order methods'],
          ['Object-keys / values / entries / assign / freeze', 'Object utilities'],
          ['JSON-stringify / JSON-parse / JSON-parse-safe', 'JSON serialization'],
          ['Math-random / Math-range', 'Random number generation'],
          ['URL-params / history-push / location-redirect', 'URL & routing'],
        ],
      },
    ], []);



    // Expose focus() to parent
    useImperativeHandle(ref, () => ({
      focus() {
        editorRef.current?.focus();
      },
    }));

    // ── Before mount: configure Monaco globally ─────────────────────────
    const handleBeforeMount: BeforeMount = useCallback((monaco) => {
      monacoRef.current = monaco;
      // Register Java/Spring/Hibernate IntelliSense completions (once)
      registerJavaCompletions(monaco);
      // Trigger useFrontendCompletions by updating state
      setMonacoInstance(monaco);
    }, []);

    // ── On mount: bind anti-cheat commands ────────────────────────────────
    //
    // IMPORTANT — Anti-cheat approach with Monaco:
    // Monaco intercepts keyboard events internally via its own keybinding system.
    // Standard React synthetic events (onCopy/onCut/onPaste on the div wrapper)
    // do NOT fire when the user copies inside the Monaco editor because Monaco
    // calls e.stopPropagation() before events bubble up to the DOM.
    //
    // Solution: Override Monaco's built-in copy/cut/paste commands via
    // editor.addCommand() and editor.addAction(). This hooks into Monaco's
    // keybinding layer BEFORE the clipboard action executes, allowing us to
    // prevent it and trigger our violation logic.
    //
    const handleEditorMount: OnMount = useCallback(
      (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        const { KeyMod, KeyCode } = monaco;

        // ── Override Ctrl+C (copy) ────────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyC, () => {
          onCopyAttempt();
          // Do NOT call the original clipboard copy action
        });

        // ── Override Ctrl+X (cut) ─────────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyX, () => {
          onCutAttempt();
        });

        // ── Override Ctrl+V (paste) ───────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyV, () => {
          onPasteAttempt();
        });

        // ── Override Shift+Delete (cut shortcut) ──────────────────────────
        editor.addCommand(KeyMod.Shift | KeyCode.Delete, () => {
          onCutAttempt();
        });

        // ── Override Ctrl+Insert (copy shortcut) ──────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Insert, () => {
          onCopyAttempt();
        });

        // ── Override Shift+Insert (paste shortcut) ────────────────────────
        editor.addCommand(KeyMod.Shift | KeyCode.Insert, () => {
          onPasteAttempt();
        });

        // ── Override right-click context menu ────────────────────────────
        // Remove copy/cut/paste from Monaco's context menu
        // Monaco uses action IDs to register context menu items.
        // We override the three clipboard actions to no-ops so they
        // don't appear or don't work via context menu.
        editor.addAction({
          id: 'editor.action.clipboardCopyAction',
          label: 'Copy (disabled)',
          run() {
            onCopyAttempt();
          },
        });
        editor.addAction({
          id: 'editor.action.clipboardCutAction',
          label: 'Cut (disabled)',
          run() {
            onCutAttempt();
          },
        });
        editor.addAction({
          id: 'editor.action.clipboardPasteAction',
          label: 'Paste (disabled)',
          run() {
            onPasteAttempt();
          },
        });

        // ── Disable drag-and-drop (another paste vector) ──────────────────
        editor.onMouseDown((e) => {
          if (e.event.browserEvent.type === 'dragstart') {
            e.event.browserEvent.preventDefault();
          }
        });

        // Auto-focus
        editor.focus();
      },
      [onCopyAttempt, onCutAttempt, onPasteAttempt]
    );

    // ── Language change handler ────────────────────────────────────────────
    const handleLanguageChange = useCallback(
      (e: React.ChangeEvent<HTMLSelectElement>) => {
        setLanguage(e.target.value as SupportedLanguage);
      },
      []
    );

    // ── Sync language prop if parent changes it (question navigation) ──────
    // (defaultLanguage only used as initial value; language selector is
    //  controlled locally so student can override it)

    return (
      <div className="code-editor-wrapper">
        {/* ── Language selector bar ─────────────────────────────────────── */}
        <div className="code-editor-toolbar">
          <span className="code-editor-toolbar-label">Language:</span>
          <select
            value={language}
            onChange={handleLanguageChange}
            className="code-editor-lang-select"
            title="Select coding language for syntax highlighting"
          >
            {LANGUAGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`code-editor-guide-btn${showGuide ? ' active' : ''}`}
            onClick={toggleGuide}
            title="IntelliSense Prefix Reference — click to toggle"
          >
            📖 IntelliSense Guide
          </button>

          <span className="code-editor-hint">
            💡 Press <kbd>Ctrl</kbd>+<kbd>Space</kbd> to trigger suggestions
          </span>
        </div>

        {/* ── IntelliSense Prefix Guide ────────────────────────────────── */}
        {showGuide && (
          <div className="code-editor-guide">
            <div className="code-editor-guide-header">
              <strong>📖 IntelliSense Prefix Reference</strong>
              <p className="code-editor-guide-desc">
                Gõ đúng <strong>prefix</strong> bên dưới rồi nhấn <kbd>Ctrl</kbd>+<kbd>Space</kbd> để xem gợi ý.
                <br />
                <strong>Java:</strong> <code>str.</code>, <code>list.</code>, <code>ldt.</code>, <code>ScannerStdin</code>, <code>JDBC Connect</code>...
                <br />
                <strong>HTML/BS5:</strong> <code>html5</code>, <code>navbar</code>, <code>card</code>, <code>modal</code>, <code>form-bs</code>, <code>table-bs</code>...
                <br />
                <strong>CSS:</strong> <code>flex-center</code>, <code>grid-2col</code>, <code>@media-md</code>, <code>fade-in</code>, <code>glassmorphism</code>...
                <br />
                <strong>JS:</strong> <code>qsel</code>, <code>fetch-async</code>, <code>addEventListener</code>, <code>cl</code>, <code>Array-map</code>...
              </p>
            </div>
            <div className="code-editor-guide-groups">
              {PREFIX_GROUPS.map(group => (
                <div key={group.group} className="code-editor-guide-group">
                  <div className="code-editor-guide-group-title">{group.group}</div>
                  <table className="code-editor-guide-table">
                    <thead>
                      <tr>
                        <th>Prefix / Snippet</th>
                        <th>Represents</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map(([prefix, desc]) => (
                        <tr key={prefix}>
                          <td><code>{prefix}</code></td>
                          <td>{desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Monaco Editor ────────────────────────────────────────────── */}
        <div
          className="code-editor-container"
          // Intercept native drag-drop paste at DOM level as a safety net
          onDrop={(e) => {
            e.preventDefault();
            onPasteAttempt();
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <Editor
            height={height}
            language={language}
            theme="vs-dark"
            value={value}
            options={{
              fontSize: 16,
              lineHeight: 1.8,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
              fontLigatures: true,
              minimap: { enabled: false },
              wordWrap: 'on',
              // IntelliSense
              quickSuggestions: { other: true, comments: false, strings: true },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: 'on',
              tabCompletion: 'on',
              parameterHints: { enabled: true },
              // Formatting
              tabSize: 4,
              insertSpaces: true,
              formatOnType: true,
              formatOnPaste: false, // security: we block paste anyway
              autoIndent: 'full',
              // UX
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderLineHighlight: 'all',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              // Disable built-in clipboard integration at editor config level
              // (commands are already overridden above, but this adds extra protection)
              emptySelectionClipboard: false,
              copyWithSyntaxHighlighting: false,
              // Accessibility
              accessibilitySupport: 'auto',
              // Disable drag-drop at editor level
              dragAndDrop: false,
              // Read-only when exam is locked
              readOnly: disabled,
              // Line numbers
              lineNumbers: 'on',
              glyphMargin: false,
              folding: true,
            }}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            onChange={(val) => onChange(val ?? '')}
            loading={
              <div className="code-editor-loading">
                <span>Loading editor...</span>
              </div>
            }
          />
        </div>
      </div>
    );
  }
);

export default CodeEditor;
