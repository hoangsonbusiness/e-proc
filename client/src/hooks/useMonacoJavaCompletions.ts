import type * as Monaco from 'monaco-editor';
import { getJavaMethodCompletions } from './javaMethodCompletions';

// ─── Helper ────────────────────────────────────────────────────────────────

function makeSnippet(
  monaco: typeof Monaco,
  label: string,
  insertText: string,
  detail: string,
  documentation: string,
  kind: Monaco.languages.CompletionItemKind
): Monaco.languages.CompletionItem {
  return {
    label,
    kind,
    detail,
    documentation: { value: documentation, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  };
}

// ─── Java Core Keywords & Types ────────────────────────────────────────────

function getJavaKeywords(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const keywords = [
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch',
    'char', 'class', 'const', 'continue', 'default', 'do', 'double',
    'else', 'enum', 'extends', 'final', 'finally', 'float', 'for',
    'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface',
    'long', 'native', 'new', 'package', 'private', 'protected', 'public',
    'return', 'short', 'static', 'strictfp', 'super', 'switch',
    'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
    'var', 'void', 'volatile', 'while', 'record', 'sealed', 'permits',
    'null', 'true', 'false',
    // Common types
    'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte',
    'Short', 'Character', 'Object', 'Number',
    // Collections
    'List', 'ArrayList', 'LinkedList', 'Map', 'HashMap', 'LinkedHashMap',
    'TreeMap', 'Set', 'HashSet', 'LinkedHashSet', 'TreeSet',
    'Queue', 'Deque', 'ArrayDeque', 'Stack', 'Vector',
    'Collection', 'Collections', 'Arrays', 'Iterator',
    'Optional', 'Stream', 'Collectors',
    // Functional
    'Function', 'Predicate', 'Consumer', 'Supplier', 'BiFunction',
    'BiPredicate', 'BiConsumer', 'UnaryOperator', 'BinaryOperator',
    // Utility
    'System', 'Math', 'Runtime', 'Thread', 'Runnable', 'Callable',
    'Exception', 'RuntimeException', 'IllegalArgumentException',
    'NullPointerException', 'IndexOutOfBoundsException',
    'UnsupportedOperationException', 'IllegalStateException',
    'StringBuilder', 'StringBuffer', 'Enum', 'Comparable', 'Iterable',
  ];

  return keywords.map(kw => ({
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    detail: 'Java keyword / type',
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Java Snippets ─────────────────────────────────────────────────────────

function getJavaSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'psvm', 'public static void main(String[] args) {\n\t$0\n}',
      'Main method', 'Public static void main entry point', CIK.Snippet),
    makeSnippet(monaco, 'sout', 'System.out.println($0);',
      'Print line', 'System.out.println()', CIK.Snippet),
    makeSnippet(monaco, 'souf', 'System.out.printf("$1%n", $0);',
      'Printf', 'System.out.printf()', CIK.Snippet),
    makeSnippet(monaco, 'fori', 'for (int $1 = 0; $1 < $2; $1++) {\n\t$0\n}',
      'for loop (index)', 'Standard indexed for loop', CIK.Snippet),
    makeSnippet(monaco, 'foreach', 'for ($1 $2 : $3) {\n\t$0\n}',
      'for-each loop', 'Enhanced for loop', CIK.Snippet),
    makeSnippet(monaco, 'trycatch', 'try {\n\t$1\n} catch ($2 e) {\n\t$0\n}',
      'try-catch', 'Try-catch block', CIK.Snippet),
    makeSnippet(monaco, 'tryfin', 'try {\n\t$1\n} catch ($2 e) {\n\t$3\n} finally {\n\t$0\n}',
      'try-catch-finally', 'Try-catch-finally block', CIK.Snippet),
    makeSnippet(monaco, 'ifnull', 'if ($1 == null) {\n\t$0\n}',
      'null check', 'Null check if', CIK.Snippet),
    makeSnippet(monaco, 'opt', 'Optional.ofNullable($1).orElse($0);',
      'Optional.ofNullable', 'Optional null-safe get', CIK.Snippet),
    makeSnippet(monaco, 'lambda', '($1) -> $0',
      'Lambda expression', 'Lambda arrow function', CIK.Snippet),
    makeSnippet(monaco, 'stream', '$1.stream()\n\t.filter($2)\n\t.map($3)\n\t.collect(Collectors.toList());',
      'Stream pipeline', 'Stream API chain', CIK.Snippet),
    makeSnippet(monaco, 'class', 'public class $1 {\n\t$0\n}',
      'Class definition', 'Public class', CIK.Snippet),
    makeSnippet(monaco, 'interface', 'public interface $1 {\n\t$0\n}',
      'Interface definition', 'Public interface', CIK.Snippet),
    makeSnippet(monaco, 'enum', 'public enum $1 {\n\t$0\n}',
      'Enum definition', 'Public enum', CIK.Snippet),
    makeSnippet(monaco, 'record', 'public record $1($2) {}',
      'Record class', 'Java 16+ record', CIK.Snippet),
    makeSnippet(monaco, 'getter',
      'public $1 get${2:Field}() {\n\treturn this.$3;\n}',
      'Getter method', 'Getter accessor', CIK.Snippet),
    makeSnippet(monaco, 'setter',
      'public void set${1:Field}($2 $3) {\n\tthis.$4 = $3;\n}',
      'Setter method', 'Setter mutator', CIK.Snippet),
    makeSnippet(monaco, 'override',
      '@Override\npublic $1 $2($3) {\n\t$0\n}',
      '@Override method', 'Overridden method', CIK.Snippet),
    makeSnippet(monaco, 'tostring',
      '@Override\npublic String toString() {\n\treturn "$1{" +\n\t\t"field=" + $2 +\n\t\t\'}\';\n}',
      'toString override', 'toString() method', CIK.Snippet),
    makeSnippet(monaco, 'hashequals',
      '@Override\npublic boolean equals(Object o) {\n\tif (this == o) return true;\n\tif (!(o instanceof $1)) return false;\n\t$1 that = ($1) o;\n\treturn Objects.equals($2, that.$2);\n}\n\n@Override\npublic int hashCode() {\n\treturn Objects.hash($2);\n}',
      'equals & hashCode', 'equals and hashCode override', CIK.Snippet),
  ];
}

// ─── Spring Framework ──────────────────────────────────────────────────────

function getSpringAnnotations(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;

  const annotations: Array<[string, string, string, string]> = [
    // Core
    ['@SpringBootApplication', '@SpringBootApplication', 'spring-boot', 'Marks the main class of a Spring Boot application. Combines @Configuration, @EnableAutoConfiguration and @ComponentScan.'],
    ['@Configuration', '@Configuration', 'spring-context', 'Indicates that the class can be used by the Spring IoC container as a source of bean definitions.'],
    ['@Bean', '@Bean\npublic $1 $2() {\n\treturn new $1();\n}', 'spring-context', 'Indicates that a method produces a bean to be managed by the Spring container.'],
    ['@Component', '@Component', 'spring-context', 'Generic stereotype annotation indicating the class is a Spring component.'],
    ['@Service', '@Service', 'spring-stereotype', 'Indicates that an annotated class is a Service component in the service layer.'],
    ['@Repository', '@Repository', 'spring-stereotype', 'Indicates that an annotated class is a Repository component in the persistence layer.'],
    ['@Controller', '@Controller', 'spring-mvc', 'Indicates that an annotated class is a Controller in the MVC pattern.'],
    ['@RestController', '@RestController', 'spring-mvc', 'Combines @Controller and @ResponseBody. All methods return domain objects instead of views.'],
    ['@Autowired', '@Autowired', 'spring-beans', 'Marks a constructor, field, setter or config method as to be autowired by Spring dependency injection.'],
    ['@Qualifier', '@Qualifier("$1")', 'spring-beans', 'Specifies which bean to autowire when multiple candidates are available.'],
    ['@Value', '@Value("${$1}")', 'spring-beans', 'Injects value from properties file or environment variables.'],
    ['@Primary', '@Primary', 'spring-beans', 'Indicates that a bean should be given preference when multiple candidates qualify to autowire.'],
    ['@Lazy', '@Lazy', 'spring-context', 'Indicates whether a bean is to be lazily initialized.'],
    ['@Scope', '@Scope("$1")', 'spring-context', 'Configures the scope of a Spring bean. E.g. singleton, prototype, request, session.'],
    ['@Profile', '@Profile("$1")', 'spring-context', 'Indicates that a component is eligible for registration when the specified profiles are active.'],
    ['@PropertySource', '@PropertySource("classpath:$1.properties")', 'spring-context', 'Adds a PropertySource to Spring Environment.'],
    ['@ComponentScan', '@ComponentScan(basePackages = "$1")', 'spring-context', 'Configures component scanning directives for use with @Configuration classes.'],
    ['@EnableAutoConfiguration', '@EnableAutoConfiguration', 'spring-boot', 'Enables Spring Boot auto-configuration mechanism.'],
    ['@Conditional', '@Conditional($1.class)', 'spring-context', 'Indicates that a component is eligible for registration when a condition matches.'],
    ['@ConditionalOnProperty', '@ConditionalOnProperty(name = "$1", havingValue = "$2")', 'spring-boot', 'Conditionally create bean based on property value.'],
    ['@ConditionalOnMissingBean', '@ConditionalOnMissingBean', 'spring-boot', 'Conditionally create bean when no bean of specified type exists.'],
    ['@EnableScheduling', '@EnableScheduling', 'spring-context', 'Enables Spring scheduling capabilities.'],
    ['@Scheduled', '@Scheduled(fixedRate = $1)', 'spring-context', 'Marks a method to be scheduled. Supports fixedRate, fixedDelay, cron.'],
    ['@Async', '@Async', 'spring-context', 'Marks a method as asynchronous execution candidate.'],
    ['@EnableAsync', '@EnableAsync', 'spring-context', 'Enables Spring asynchronous method execution.'],
    ['@EventListener', '@EventListener', 'spring-context', 'Marks a method as listener for application events.'],
    // Web / MVC
    ['@RequestMapping', '@RequestMapping(value = "/$1", method = RequestMethod.$2)', 'spring-mvc', 'Maps web requests to handler classes or methods.'],
    ['@GetMapping', '@GetMapping("/$1")', 'spring-mvc', 'Shortcut for @RequestMapping with method = GET.'],
    ['@PostMapping', '@PostMapping("/$1")', 'spring-mvc', 'Shortcut for @RequestMapping with method = POST.'],
    ['@PutMapping', '@PutMapping("/$1")', 'spring-mvc', 'Shortcut for @RequestMapping with method = PUT.'],
    ['@DeleteMapping', '@DeleteMapping("/$1")', 'spring-mvc', 'Shortcut for @RequestMapping with method = DELETE.'],
    ['@PatchMapping', '@PatchMapping("/$1")', 'spring-mvc', 'Shortcut for @RequestMapping with method = PATCH.'],
    ['@RequestBody', '@RequestBody', 'spring-mvc', 'Indicates a method parameter should be bound to the HTTP request body.'],
    ['@ResponseBody', '@ResponseBody', 'spring-mvc', 'Indicates a method return value should be bound to the HTTP response body.'],
    ['@PathVariable', '@PathVariable("$1") $2 $3', 'spring-mvc', 'Indicates a method parameter should be bound to a URI template variable.'],
    ['@RequestParam', '@RequestParam(value = "$1", required = false) $2 $3', 'spring-mvc', 'Indicates a method parameter should be bound to a web request parameter.'],
    ['@RequestHeader', '@RequestHeader("$1") $2 $3', 'spring-mvc', 'Indicates a method parameter should be bound to a web request header.'],
    ['@ResponseStatus', '@ResponseStatus(HttpStatus.$1)', 'spring-mvc', 'Marks a method or exception class with the status code and reason message that should be returned.'],
    ['@ExceptionHandler', '@ExceptionHandler($1.class)', 'spring-mvc', 'Annotation for handling exceptions in specific handler classes or handler methods.'],
    ['@ControllerAdvice', '@ControllerAdvice', 'spring-mvc', 'Specialization of @Component for classes that declare @ExceptionHandler, @InitBinder, or @ModelAttribute methods.'],
    ['@RestControllerAdvice', '@RestControllerAdvice', 'spring-mvc', 'Combines @ControllerAdvice and @ResponseBody.'],
    ['@CrossOrigin', '@CrossOrigin(origins = "$1")', 'spring-mvc', 'Enables cross-origin requests for the annotated method or class.'],
    ['@Valid', '@Valid', 'spring-validation', 'Triggers validation on annotated bean using Bean Validation API.'],
    ['@Validated', '@Validated', 'spring-validation', 'Triggers Spring Validation.'],
    // Transaction
    ['@Transactional', '@Transactional', 'spring-tx', 'Describes transaction attributes on a method or class. Manages commit/rollback automatically.'],
    ['@EnableTransactionManagement', '@EnableTransactionManagement', 'spring-tx', 'Enables Spring annotation-driven transaction management.'],
    // Data
    ['@EnableJpaRepositories', '@EnableJpaRepositories(basePackages = "$1")', 'spring-data', 'Enables Spring Data JPA repositories.'],
    ['@EnableCaching', '@EnableCaching', 'spring-cache', 'Enables Spring annotation-driven cache management.'],
    ['@Cacheable', '@Cacheable("$1")', 'spring-cache', 'Indicates that the result of invoking a method can be cached.'],
    ['@CacheEvict', '@CacheEvict(value = "$1", allEntries = true)', 'spring-cache', 'Indicates that a method triggers cache eviction.'],
    ['@CachePut', '@CachePut(value = "$1", key = "#$2")', 'spring-cache', 'Indicates that a method updates cache without interfering with method execution.'],
  ];

  return annotations.map(([label, insertText, detail, documentation]) => ({
    label,
    kind: CIK.Property,
    detail,
    documentation: { value: `**${label}**\n\n${documentation}`, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Hibernate / JPA ──────────────────────────────────────────────────────

function getHibernateAnnotations(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;

  const annotations: Array<[string, string, string, string]> = [
    // Entity mapping
    ['@Entity', '@Entity', 'jakarta.persistence', 'Specifies that the class is an entity mapped to a database table.'],
    ['@Table', '@Table(name = "$1")', 'jakarta.persistence', 'Specifies the primary table for the annotated entity.'],
    ['@Id', '@Id', 'jakarta.persistence', 'Specifies the primary key of an entity.'],
    ['@GeneratedValue', '@GeneratedValue(strategy = GenerationType.$1)', 'jakarta.persistence', 'Provides the generation strategies for the values of primary keys. IDENTITY, SEQUENCE, TABLE, AUTO.'],
    ['@SequenceGenerator', '@SequenceGenerator(name = "$1", sequenceName = "$2", allocationSize = 1)', 'jakarta.persistence', 'Defines a primary key generator that may be referenced by @GeneratedValue.'],
    ['@TableGenerator', '@TableGenerator(name = "$1", table = "$2")', 'jakarta.persistence', 'Defines a generator for primary key values backed by a database table.'],
    ['@Column', '@Column(name = "$1", nullable = false, length = $2)', 'jakarta.persistence', 'Specifies the mapped column for a persistent property or field.'],
    ['@Basic', '@Basic(fetch = FetchType.$1)', 'jakarta.persistence', 'Defines the default fetch and optional behavior for entity attributes.'],
    ['@Lob', '@Lob', 'jakarta.persistence', 'Specifies that a persistent property or field should be persisted as a large object to a database-supported large object type.'],
    ['@Temporal', '@Temporal(TemporalType.$1)', 'jakarta.persistence', 'Specifies the type of a java.util.Date or java.util.Calendar.'],
    ['@Transient', '@Transient', 'jakarta.persistence', 'Specifies that the property or field is not persistent. NOT the same as Spring @Transactional!'],
    ['@Enumerated', '@Enumerated(EnumType.STRING)', 'jakarta.persistence', 'Specifies that a persistent property or field should be persisted as an enumerated type.'],
    ['@Embedded', '@Embedded', 'jakarta.persistence', 'Specifies a persistent field or property of an entity whose value is an instance of an embeddable class.'],
    ['@Embeddable', '@Embeddable', 'jakarta.persistence', 'Defines a class whose instances are stored as an intrinsic part of an owning entity.'],
    ['@EmbeddedId', '@EmbeddedId', 'jakarta.persistence', 'Applied to a persistent field or property of an entity class or mapped superclass to denote a composite primary key.'],
    // Associations
    ['@OneToOne', '@OneToOne(mappedBy = "$1", cascade = CascadeType.ALL, fetch = FetchType.LAZY)', 'jakarta.persistence', 'Defines a single-valued association to another entity that has one-to-one multiplicity.'],
    ['@OneToMany', '@OneToMany(mappedBy = "$1", cascade = CascadeType.ALL, fetch = FetchType.LAZY, orphanRemoval = true)', 'jakarta.persistence', 'Defines a many-valued association with one-to-many multiplicity.'],
    ['@ManyToOne', '@ManyToOne(fetch = FetchType.LAZY)', 'jakarta.persistence', 'Defines a single-valued association to another entity class that has many-to-one multiplicity.'],
    ['@ManyToMany', '@ManyToMany(cascade = {CascadeType.PERSIST, CascadeType.MERGE})', 'jakarta.persistence', 'Defines a many-valued association with many-to-many multiplicity.'],
    ['@JoinColumn', '@JoinColumn(name = "$1", nullable = false)', 'jakarta.persistence', 'Specifies a column for joining an entity association or element collection.'],
    ['@JoinTable', '@JoinTable(name = "$1",\n\tjoinColumns = @JoinColumn(name = "$2"),\n\tinverseJoinColumns = @JoinColumn(name = "$3"))', 'jakarta.persistence', 'Specifies the mapping of associations. Applied to the owning side of an association.'],
    // Queries
    ['@NamedQuery', '@NamedQuery(name = "$1", query = "$2")', 'jakarta.persistence', 'Specifies a static, named JPQL query.'],
    ['@NamedNativeQuery', '@NamedNativeQuery(name = "$1", query = "$2", resultClass = $3.class)', 'jakarta.persistence', 'Specifies a static, named native SQL query.'],
    ['@NamedQueries', '@NamedQueries({\n\t@NamedQuery(name = "$1", query = "$2")\n})', 'jakarta.persistence', 'Groups multiple named queries.'],
    ['@Query', '@Query("$1")', 'spring-data', 'Declares a finder query directly on a repository method.'],
    ['@Modifying', '@Modifying\n@Transactional', 'spring-data', 'Indicates a @Query annotated method should be considered as modifying query.'],
    // Hierarchy
    ['@Inheritance', '@Inheritance(strategy = InheritanceType.$1)', 'jakarta.persistence', 'Defines the inheritance strategy to be used for an entity class hierarchy.'],
    ['@DiscriminatorColumn', '@DiscriminatorColumn(name = "$1", discriminatorType = DiscriminatorType.STRING)', 'jakarta.persistence', 'Specifies the discriminator column for the SINGLE_TABLE and JOINED inheritance mapping strategies.'],
    ['@DiscriminatorValue', '@DiscriminatorValue("$1")', 'jakarta.persistence', 'Specifies the value of the discriminator column for entities of the given type.'],
    ['@MappedSuperclass', '@MappedSuperclass', 'jakarta.persistence', 'Designates a class whose mapping information is applied to the entities that inherit from it.'],
    // Hibernate-specific
    ['@DynamicInsert', '@DynamicInsert', 'org.hibernate.annotations', 'Only include changed columns in INSERT SQL.'],
    ['@DynamicUpdate', '@DynamicUpdate', 'org.hibernate.annotations', 'Only include changed columns in UPDATE SQL.'],
    ['@BatchSize', '@BatchSize(size = $1)', 'org.hibernate.annotations', 'Defines the batch fetching strategy for the annotated entity or collection.'],
    ['@Fetch', '@Fetch(FetchMode.$1)', 'org.hibernate.annotations', 'Defines the fetching strategy for the given association or collection. SELECT, JOIN, SUBSELECT.'],
    ['@LazyCollection', '@LazyCollection(LazyCollectionOption.$1)', 'org.hibernate.annotations', 'Lazy collection option: TRUE, FALSE, EXTRA.'],
    ['@Cache', '@Cache(usage = CacheConcurrencyStrategy.$1)', 'org.hibernate.annotations', 'Second-level caching configuration for entity or collection.'],
    ['@NaturalId', '@NaturalId', 'org.hibernate.annotations', 'Specifies that a property is part of the natural id of the entity.'],
    ['@CreationTimestamp', '@CreationTimestamp', 'org.hibernate.annotations', 'Marks a property as a creation timestamp; value is set on insert.'],
    ['@UpdateTimestamp', '@UpdateTimestamp', 'org.hibernate.annotations', 'Marks a property as an update timestamp; value is set on update.'],
    ['@Formula', '@Formula("$1")', 'org.hibernate.annotations', 'Defines a formula (derived property) mapped to a SQL fragment.'],
    ['@Where', '@Where(clause = "$1")', 'org.hibernate.annotations', 'Specifies additional criteria to be applied to the SQL WHERE clause.'],
    ['@Filter', '@Filter(name = "$1")', 'org.hibernate.annotations', 'Defines a filter to be applied to an entity or collection.'],
    ['@FilterDef', '@FilterDef(name = "$1", parameters = @ParamDef(name = "$2", type = "$3"))', 'org.hibernate.annotations', 'Defines a filter definition.'],
    ['@SQLInsert', '@SQLInsert(sql = "$1")', 'org.hibernate.annotations', 'Overrides the SQL INSERT statement.'],
    ['@SQLUpdate', '@SQLUpdate(sql = "$1")', 'org.hibernate.annotations', 'Overrides the SQL UPDATE statement.'],
    ['@SQLDelete', '@SQLDelete(sql = "$1")', 'org.hibernate.annotations', 'Overrides the SQL DELETE statement.'],
    ['@SoftDelete', '@SoftDelete', 'org.hibernate.annotations', 'Configures a soft-delete (logical delete) for the entity.'],
    ['@Type', '@Type(value = $1.class)', 'org.hibernate.annotations', 'Declares a specific Hibernate type for the annotated field.'],
  ];

  return annotations.map(([label, insertText, detail, documentation]) => ({
    label,
    kind: CIK.Property,
    detail,
    documentation: { value: `**${label}**\n\n${documentation}`, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Spring Data Repository methods ───────────────────────────────────────

function getSpringDataMethods(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  const methods: Array<[string, string, string]> = [
    ['findAll()', 'findAll()', 'CrudRepository - Returns all entities'],
    ['findById(id)', 'findById($1)', 'CrudRepository - Returns Optional<T>'],
    ['findAllById(ids)', 'findAllById($1)', 'CrudRepository - Returns Iterable<T>'],
    ['save(entity)', 'save($1)', 'CrudRepository - Saves entity, returns saved entity'],
    ['saveAll(entities)', 'saveAll($1)', 'CrudRepository - Saves all entities'],
    ['saveAndFlush(entity)', 'saveAndFlush($1)', 'JpaRepository - Saves and flushes immediately'],
    ['delete(entity)', 'delete($1)', 'CrudRepository - Deletes entity'],
    ['deleteById(id)', 'deleteById($1)', 'CrudRepository - Deletes by ID'],
    ['deleteAll()', 'deleteAll()', 'CrudRepository - Deletes all entities'],
    ['deleteAllById(ids)', 'deleteAllById($1)', 'CrudRepository - Deletes by IDs'],
    ['count()', 'count()', 'CrudRepository - Returns count of entities'],
    ['existsById(id)', 'existsById($1)', 'CrudRepository - Returns boolean'],
    ['flush()', 'flush()', 'JpaRepository - Flushes pending changes'],
    ['findAll(Pageable)', 'findAll($1)', 'PagingAndSortingRepository - Returns Page<T>'],
    ['findAll(Sort)', 'findAll(Sort.by("$1").ascending())', 'PagingAndSortingRepository - Returns sorted list'],
    ['findByXxx(value)', 'findBy$1($2)', 'Spring Data - Derived query by field name'],
    ['findAllByXxx(value)', 'findAllBy$1($2)', 'Spring Data - Derived find all query'],
    ['countByXxx(value)', 'countBy$1($2)', 'Spring Data - Count by field'],
    ['existsByXxx(value)', 'existsBy$1($2)', 'Spring Data - Exists by field'],
    ['deleteByXxx(value)', 'deleteBy$1($2)', 'Spring Data - Delete by field'],
    ['PageRequest.of()', 'PageRequest.of($1, $2, Sort.by("$3"))', 'Pagination - Create pageable from page and size'],
  ];

  return methods.map(([label, insertText, detail]) => ({
    label,
    kind: CIK.Method,
    detail,
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Spring Service / Component snippets ──────────────────────────────────

function getSpringSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'SpringService',
      '@Service\n@RequiredArgsConstructor\npublic class $1Service {\n\n\tprivate final $2Repository $3Repository;\n\n\tpublic $4 $5($6) {\n\t\t$0\n\t}\n}',
      'Spring Service class', 'Full Spring @Service class template', CIK.Snippet),
    makeSnippet(monaco, 'SpringController',
      '@RestController\n@RequestMapping("/api/$1")\n@RequiredArgsConstructor\npublic class $2Controller {\n\n\tprivate final $3Service $4Service;\n\n\t@GetMapping\n\tpublic ResponseEntity<List<$5>> getAll() {\n\t\treturn ResponseEntity.ok($4Service.findAll());\n\t}\n\n\t@GetMapping("/{id}")\n\tpublic ResponseEntity<$5> getById(@PathVariable Long id) {\n\t\treturn ResponseEntity.ok($4Service.findById(id));\n\t}\n}',
      'Spring REST Controller class', 'Full @RestController template', CIK.Snippet),
    makeSnippet(monaco, 'SpringRepository',
      '@Repository\npublic interface $1Repository extends JpaRepository<$2, $3> {\n\n\tOptional<$2> findBy$4($5 $6);\n\n\t@Query("SELECT e FROM $2 e WHERE $0")\n\tList<$2> findCustom(@Param("$7") $8 $9);\n}',
      'Spring JPA Repository', 'Full @Repository interface template', CIK.Snippet),
    makeSnippet(monaco, 'JpaEntity',
      '@Entity\n@Table(name = "$1")\n@Getter\n@Setter\n@NoArgsConstructor\n@AllArgsConstructor\n@Builder\npublic class $2 {\n\n\t@Id\n\t@GeneratedValue(strategy = GenerationType.IDENTITY)\n\tprivate Long id;\n\n\t@Column(name = "$3", nullable = false)\n\tprivate $4 $5;\n\n\t@CreationTimestamp\n\t@Column(name = "created_at", updatable = false)\n\tprivate LocalDateTime createdAt;\n\n\t@UpdateTimestamp\n\t@Column(name = "updated_at")\n\tprivate LocalDateTime updatedAt;\n}',
      'JPA Entity class', 'Full @Entity class with Lombok', CIK.Snippet),
    makeSnippet(monaco, 'ResponseEntity',
      'ResponseEntity.ok($1)',
      'ResponseEntity.ok()', 'HTTP 200 OK response', CIK.Method),
    makeSnippet(monaco, 'ResponseEntityCreated',
      'ResponseEntity.status(HttpStatus.CREATED).body($1)',
      'ResponseEntity 201', 'HTTP 201 Created response', CIK.Method),
    makeSnippet(monaco, 'ResponseEntityNotFound',
      'ResponseEntity.notFound().build()',
      'ResponseEntity 404', 'HTTP 404 Not Found response', CIK.Method),
    makeSnippet(monaco, 'EntityManager',
      'entityManager.createQuery("$1", $2.class)\n\t.setParameter("$3", $4)\n\t.getResultList()',
      'EntityManager query', 'JPQL query via EntityManager', CIK.Snippet),
    makeSnippet(monaco, 'CriteriaBuilder',
      'CriteriaBuilder cb = entityManager.getCriteriaBuilder();\nCriteriaQuery<$1> query = cb.createQuery($1.class);\nRoot<$1> root = query.from($1.class);\nquery.select(root).where(cb.equal(root.get("$2"), $3));\nList<$1> results = entityManager.createQuery(query).getResultList();',
      'Criteria API query', 'JPA Criteria API template', CIK.Snippet),
  ];
}

// ─── Lombok Annotations ───────────────────────────────────────────────────

function getLombokAnnotations(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  // Each entry: [label, insertText, documentation?]
  const annotations: Array<[string, string, string?]> = [
    ['@Getter', '@Getter', 'Generates getters for all fields'],
    ['@Setter', '@Setter', 'Generates setters for all non-final fields'],
    ['@ToString', '@ToString', 'Generates toString() method'],
    ['@EqualsAndHashCode', '@EqualsAndHashCode', 'Generates equals() and hashCode() methods'],
    ['@NoArgsConstructor', '@NoArgsConstructor', 'Generates no-args constructor'],
    ['@AllArgsConstructor', '@AllArgsConstructor', 'Generates all-args constructor'],
    ['@RequiredArgsConstructor', '@RequiredArgsConstructor', 'Generates constructor for final/non-null fields'],
    ['@Data', '@Data', 'Combines @Getter, @Setter, @ToString, @EqualsAndHashCode, @RequiredArgsConstructor'],
    ['@Builder', '@Builder', 'Implements the builder pattern for the class'],
    ['@SuperBuilder', '@SuperBuilder', 'Builder pattern that works with inheritance'],
    ['@Value', '@Value', 'Immutable version of @Data (all fields private final)'],
    ['@Slf4j', '@Slf4j', 'Injects a SLF4J Logger field: private static final Logger log'],
    ['@Log4j2', '@Log4j2', 'Injects a Log4j2 Logger field'],
    ['@NonNull', '@NonNull', 'Generates null-check and throws NullPointerException if null'],
    ['@SneakyThrows', '@SneakyThrows', 'Lets you throw checked exceptions without declaring them'],
    ['@Synchronized', '@Synchronized', 'Synchronized modifier on method, similar to synchronized but safer'],
    ['@With', '@With', 'Generates wither methods (immutable setters)'],
    ['@Cleanup', '@Cleanup', 'Ensures cleanup of a resource'],
    ['@FieldDefaults', '@FieldDefaults(level = AccessLevel.$1)', 'Configures field visibility level for all fields in the class'],
  ];

  return annotations.map(([label, insertText, documentation]) => ({
    label,
    kind: CIK.Property,
    detail: 'lombok',
    documentation: { value: `**${label}** *(Lombok)*\n\n${documentation}`, isTrusted: true },
    insertText: insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Bean Validation ──────────────────────────────────────────────────────

function getValidationAnnotations(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  const annotations: Array<[string, string, string]> = [
    ['@NotNull', '@NotNull', 'Field must not be null'],
    ['@NotBlank', '@NotBlank', 'String must not be blank (not null, not empty, not whitespace only)'],
    ['@NotEmpty', '@NotEmpty', 'Collection/String/Array must not be empty'],
    ['@Size', '@Size(min = $1, max = $2)', 'String/Collection size must be within bounds'],
    ['@Min', '@Min($1)', 'Number must be >= value'],
    ['@Max', '@Max($1)', 'Number must be <= value'],
    ['@Positive', '@Positive', 'Number must be > 0'],
    ['@PositiveOrZero', '@PositiveOrZero', 'Number must be >= 0'],
    ['@Negative', '@Negative', 'Number must be < 0'],
    ['@Email', '@Email', 'String must be a valid email'],
    ['@Pattern', '@Pattern(regexp = "$1")', 'String must match the regex pattern'],
    ['@Past', '@Past', 'Date must be in the past'],
    ['@Future', '@Future', 'Date must be in the future'],
    ['@PastOrPresent', '@PastOrPresent', 'Date must be past or present'],
    ['@FutureOrPresent', '@FutureOrPresent', 'Date must be future or present'],
    ['@DecimalMin', '@DecimalMin("$1")', 'Number must be >= decimal value'],
    ['@DecimalMax', '@DecimalMax("$1")', 'Number must be <= decimal value'],
    ['@Digits', '@Digits(integer = $1, fraction = $2)', 'Number must have at most X integer and Y fraction digits'],
    ['@AssertTrue', '@AssertTrue', 'Boolean must be true'],
    ['@AssertFalse', '@AssertFalse', 'Boolean must be false'],
  ];

  return annotations.map(([label, insertText, documentation]) => ({
    label,
    kind: CIK.Property,
    detail: 'jakarta.validation',
    documentation: { value: `**${label}** *(Bean Validation)*\n\n${documentation}`, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}


// ─── Spring Web MVC ────────────────────────────────────────────────────────

function getSpringWebMvcCompletions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;

  // ── Annotations ─────────────────────────────────────────────────────────
  const annotations: Array<[string, string, string, string]> = [
    ['@ModelAttribute',
      '@ModelAttribute("$1")',
      'spring-webmvc',
      'Binds a method parameter or method return value to a named model attribute. Can also be used at method level to provide reference data for the model.'],
    ['@SessionAttributes',
      '@SessionAttributes("$1")',
      'spring-webmvc',
      'Indicates session attributes that a specific handler uses. These are stored in the HttpSession between requests for the same user.'],
    ['@SessionAttribute',
      '@SessionAttribute("$1") $2 $3',
      'spring-webmvc',
      'Binds a method parameter to a pre-existing session attribute. Differs from @SessionAttributes in that it accesses an already-stored attribute.'],
    ['@RequestAttribute',
      '@RequestAttribute("$1") $2 $3',
      'spring-webmvc',
      'Binds a method parameter to a request attribute set by a Filter or HandlerInterceptor.'],
    ['@CookieValue',
      '@CookieValue(value = "$1", required = false) String $2',
      'spring-webmvc',
      'Binds a method parameter to an HTTP cookie value.'],
    ['@MatrixVariable',
      '@MatrixVariable(name = "$1", pathVar = "$2") $3 $4',
      'spring-webmvc',
      'Binds a method parameter to a matrix variable within a path segment. E.g. /cars;color=red.'],
    ['@RequestPart',
      '@RequestPart("$1") $2 $3',
      'spring-webmvc',
      'Binds a part of a multipart/form-data request to a method parameter. Supports MultipartFile and raw part content.'],
    ['@InitBinder',
      '@InitBinder',
      'spring-webmvc',
      'Identifies methods that initialize the WebDataBinder used for populating command and form object arguments.'],
    ['@EnableWebMvc',
      '@EnableWebMvc',
      'spring-webmvc',
      'Enables Spring MVC configuration from @Configuration classes. Equivalent to <mvc:annotation-driven />. Imports DelegatingWebMvcConfiguration.'],
    ['@WebMvcTest',
      '@WebMvcTest($1.class)',
      'spring-webmvc-test',
      'Auto-configures MockMvc and only creates beans relevant to the web layer. Use with @MockBean to mock service-layer dependencies.'],
    ['@AutoConfigureMockMvc',
      '@AutoConfigureMockMvc',
      'spring-webmvc-test',
      'Auto-configures MockMvc. Can be used with @SpringBootTest to test with the full application context.'],
    ['@MockBean',
      '@MockBean\n$1 $2;',
      'spring-test',
      'Adds a Mockito mock to the Spring application context. The mock replaces any existing bean of the same type.'],
  ];

  const annotationItems = annotations.map(([label, insertText, detail, documentation]) => ({
    label,
    kind: CIK.Property,
    detail,
    documentation: { value: `**${label}**\n\n${documentation}`, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));

  // ── Classes / Interfaces ────────────────────────────────────────────────
  const types: Array<[string, string, string, string]> = [
    ['HandlerInterceptor', 'HandlerInterceptor', 'org.springframework.web.servlet',
      'Interface for intercepting handler execution chains. Implement preHandle(), postHandle(), and afterCompletion().'],
    ['AsyncHandlerInterceptor', 'AsyncHandlerInterceptor', 'org.springframework.web.servlet',
      'Extends HandlerInterceptor with afterConcurrentHandlingStarted() for async request processing.'],
    ['WebMvcConfigurer', 'WebMvcConfigurer', 'org.springframework.web.servlet.config.annotation',
      'Callback interface to customize Java-based Spring MVC configuration — interceptors, CORS, resource handlers, view resolvers, message converters.'],
    ['WebMvcConfigurationSupport', 'WebMvcConfigurationSupport', 'org.springframework.web.servlet.config.annotation',
      'Main class providing Spring MVC configuration. Override to customize without @EnableWebMvc.'],
    ['HttpServletRequest', 'HttpServletRequest', 'jakarta.servlet.http',
      'Provides HTTP-specific request information: headers, method, URL, session, cookies, parameters.'],
    ['HttpServletResponse', 'HttpServletResponse', 'jakarta.servlet.http',
      'Provides HTTP-specific response functionality: status codes, headers, cookies, output stream.'],
    ['HttpSession', 'HttpSession', 'jakarta.servlet.http',
      'Identifies a user across multiple requests and stores user-specific session data.'],
    ['HttpEntity', 'HttpEntity<$1>', 'org.springframework.http',
      'Represents an HTTP request or response entity, consisting of headers and body.'],
    ['RequestEntity', 'RequestEntity<$1>', 'org.springframework.http',
      'Extension of HttpEntity that adds HTTP method and URI. Used as @Controller method argument.'],
    ['ModelAndView', 'ModelAndView', 'org.springframework.web.servlet',
      'Holder for both Model and View. A controller can return both view name and model attributes as a single return value.'],
    ['Model', 'Model', 'org.springframework.ui',
      'Holder for model attributes exposed to the view. Passed as a method argument to @Controller methods.'],
    ['ModelMap', 'ModelMap', 'org.springframework.ui',
      'LinkedHashMap-based implementation of Model. Use when you need Map-style access alongside Model functionality.'],
    ['RedirectAttributes', 'RedirectAttributes', 'org.springframework.web.servlet.mvc.support',
      'Specialization of Model for use after a redirect. Flash attributes survive a redirect and are then automatically removed.'],
    ['HttpStatus', 'HttpStatus', 'org.springframework.http',
      'Enum of HTTP status codes. E.g. HttpStatus.OK (200), CREATED (201), NOT_FOUND (404), BAD_REQUEST (400), FORBIDDEN (403).'],
    ['HttpHeaders', 'HttpHeaders', 'org.springframework.http',
      'Data structure representing HTTP request or response headers. Map of header names to list of String values.'],
    ['MediaType', 'MediaType', 'org.springframework.http',
      'Subclass of MimeType. Constants: APPLICATION_JSON, APPLICATION_XML, TEXT_HTML, MULTIPART_FORM_DATA, TEXT_PLAIN, APPLICATION_OCTET_STREAM.'],
    ['UriComponentsBuilder', 'UriComponentsBuilder', 'org.springframework.web.util',
      'Builder for UriComponents. Supports URI templates, variables, encoding, and construction from current request context.'],
    ['ServletUriComponentsBuilder', 'ServletUriComponentsBuilder', 'org.springframework.web.servlet.support',
      'Extends UriComponentsBuilder to build URIs based on the current HttpServletRequest.'],
    ['MultipartFile', 'MultipartFile', 'org.springframework.web.multipart',
      'Represents an uploaded file received in a multipart request. Provides access to name, original filename, content type, bytes, and InputStream.'],
    ['MultipartHttpServletRequest', 'MultipartHttpServletRequest', 'org.springframework.web.multipart',
      'Extends HttpServletRequest with methods for handling multipart content and retrieving MultipartFile objects.'],
    ['BindingResult', 'BindingResult', 'org.springframework.validation',
      'Holds data binding and validation results. Must immediately follow the @Valid/@Validated parameter in a controller method.'],
    ['Errors', 'Errors', 'org.springframework.validation',
      'Stores and exposes data-binding and validation errors. Superinterface of BindingResult.'],
    ['Validator', 'Validator', 'org.springframework.validation',
      'Spring validation interface. Implement supports() and validate(Object, Errors) for custom validation logic.'],
    ['MockMvc', 'MockMvc', 'org.springframework.test.web.servlet',
      'Main entry point for server-side Spring MVC test support. Perform requests and assert responses without starting an HTTP server.'],
    ['MockMvcRequestBuilders', 'MockMvcRequestBuilders', 'org.springframework.test.web.servlet.request',
      'Static factory methods for MockHttpServletRequestBuilder: get(), post(), put(), delete(), patch(), multipart().'],
    ['MockMvcResultMatchers', 'MockMvcResultMatchers', 'org.springframework.test.web.servlet.result',
      'Static factory methods for ResultMatcher assertions: status(), jsonPath(), content(), header(), view(), model().'],
    ['ResponseStatusException', 'ResponseStatusException', 'org.springframework.web.server',
      'Exception associated with a specific HTTP status code and reason. Use as an alternative to @ResponseStatus.'],
    ['MethodArgumentNotValidException', 'MethodArgumentNotValidException', 'org.springframework.web.bind',
      'Thrown when validation on an argument annotated with @Valid or @Validated fails. Contains BindingResult.'],
    ['MissingServletRequestParameterException', 'MissingServletRequestParameterException', 'org.springframework.web.bind',
      'Thrown when a required @RequestParam is missing from the HTTP request.'],
    ['HttpMessageNotReadableException', 'HttpMessageNotReadableException', 'org.springframework.http.converter',
      'Thrown when a request body cannot be read. Typically indicates malformed or missing JSON.'],
    ['DispatcherServlet', 'DispatcherServlet', 'org.springframework.web.servlet',
      'Central dispatcher for HTTP request handlers. Routes requests to appropriate @Controller methods.'],
    ['HandlerMapping', 'HandlerMapping', 'org.springframework.web.servlet',
      'Interface that maps requests to handler objects (controllers). E.g. RequestMappingHandlerMapping.'],
    ['HandlerAdapter', 'HandlerAdapter', 'org.springframework.web.servlet',
      'SPI adapter interface allowing parameterization of the DispatcherServlet core workflow.'],
    ['ViewResolver', 'ViewResolver', 'org.springframework.web.servlet',
      'Interface to resolve views by name. E.g. InternalResourceViewResolver, ThymeleafViewResolver.'],
    ['CorsConfiguration', 'CorsConfiguration', 'org.springframework.web.cors',
      'Container for CORS configuration with methods to check against actual origin, HTTP methods, and headers.'],
    ['CorsConfigurationSource', 'CorsConfigurationSource', 'org.springframework.web.cors',
      'Interface providing a CorsConfiguration instance based on a given request.'],
    ['UrlBasedCorsConfigurationSource', 'UrlBasedCorsConfigurationSource', 'org.springframework.web.cors',
      'CorsConfigurationSource implementation that selects CorsConfiguration based on URL path patterns.'],
  ];

  const typeItems = types.map(([label, insertText, detail, documentation]) => ({
    label,
    kind: CIK.Class,
    detail,
    documentation: { value: `**${label}**\n\n*${detail}*\n\n${documentation}`, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));

  // ── Full Code Snippets ───────────────────────────────────────────────────
  const snippets: Monaco.languages.CompletionItem[] = [

    makeSnippet(monaco, 'WebMvcConfigurer',
      '@Configuration\n@EnableWebMvc\npublic class WebMvcConfig implements WebMvcConfigurer {\n\n\t@Override\n\tpublic void addInterceptors(InterceptorRegistry registry) {\n\t\tregistry.addInterceptor(new $1Interceptor())\n\t\t\t.addPathPatterns("/api/**")\n\t\t\t.excludePathPatterns("/api/auth/**");\n\t}\n\n\t@Override\n\tpublic void addCorsMappings(CorsRegistry registry) {\n\t\tregistry.addMapping("/api/**")\n\t\t\t.allowedOrigins("$2")\n\t\t\t.allowedMethods("GET", "POST", "PUT", "DELETE", "PATCH")\n\t\t\t.allowedHeaders("*")\n\t\t\t.allowCredentials(true)\n\t\t\t.maxAge(3600);\n\t}\n\n\t@Override\n\tpublic void addResourceHandlers(ResourceHandlerRegistry registry) {\n\t\tregistry.addResourceHandler("/static/**")\n\t\t\t.addResourceLocations("classpath:/static/");\n\t}\n\n\t@Override\n\tpublic void configureMessageConverters(List<HttpMessageConverter<?>> converters) {\n\t\tconverters.add(new MappingJackson2HttpMessageConverter());\n\t}\n}',
      'spring-webmvc',
      'Full WebMvcConfigurer @Configuration class with interceptors, CORS, resource handlers and message converters',
      CIK.Snippet),

    makeSnippet(monaco, 'HandlerInterceptor',
      '@Component\npublic class $1Interceptor implements HandlerInterceptor {\n\n\t@Override\n\tpublic boolean preHandle(HttpServletRequest request,\n\t\t\tHttpServletResponse response, Object handler) throws Exception {\n\t\t// Called before the handler method is invoked.\n\t\t// Return true to continue chain, false to abort.\n\t\t$0\n\t\treturn true;\n\t}\n\n\t@Override\n\tpublic void postHandle(HttpServletRequest request,\n\t\t\tHttpServletResponse response, Object handler,\n\t\t\tModelAndView modelAndView) throws Exception {\n\t\t// Called after handler execution, before view rendering.\n\t}\n\n\t@Override\n\tpublic void afterCompletion(HttpServletRequest request,\n\t\t\tHttpServletResponse response, Object handler,\n\t\t\tException ex) throws Exception {\n\t\t// Called after the complete request has finished.\n\t}\n}',
      'spring-webmvc',
      'Full HandlerInterceptor implementation with preHandle, postHandle, and afterCompletion',
      CIK.Snippet),

    makeSnippet(monaco, 'GlobalExceptionHandler',
      '@RestControllerAdvice\n@Slf4j\npublic class GlobalExceptionHandler {\n\n\t@ExceptionHandler(MethodArgumentNotValidException.class)\n\t@ResponseStatus(HttpStatus.BAD_REQUEST)\n\tpublic Map<String, String> handleValidationErrors(MethodArgumentNotValidException ex) {\n\t\tMap<String, String> errors = new HashMap<>();\n\t\tex.getBindingResult().getFieldErrors().forEach(error ->\n\t\t\terrors.put(error.getField(), error.getDefaultMessage())\n\t\t);\n\t\treturn errors;\n\t}\n\n\t@ExceptionHandler(ResponseStatusException.class)\n\tpublic ResponseEntity<Map<String, Object>> handleResponseStatus(ResponseStatusException ex) {\n\t\tMap<String, Object> body = new LinkedHashMap<>();\n\t\tbody.put("status", ex.getStatusCode().value());\n\t\tbody.put("error", ex.getReason());\n\t\tbody.put("timestamp", LocalDateTime.now());\n\t\treturn ResponseEntity.status(ex.getStatusCode()).body(body);\n\t}\n\n\t@ExceptionHandler(Exception.class)\n\t@ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)\n\tpublic Map<String, String> handleGenericException(Exception ex) {\n\t\tlog.error("Unhandled exception", ex);\n\t\treturn Map.of("error", "Internal server error");\n\t}\n}',
      'spring-webmvc',
      'Complete @RestControllerAdvice global exception handler for Spring MVC',
      CIK.Snippet),

    makeSnippet(monaco, 'CorsConfig',
      '@Configuration\npublic class CorsConfig {\n\n\t@Bean\n\tpublic CorsConfigurationSource corsConfigurationSource() {\n\t\tCorsConfiguration config = new CorsConfiguration();\n\t\tconfig.setAllowedOrigins(List.of("$1"));\n\t\tconfig.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"));\n\t\tconfig.setAllowedHeaders(List.of("*"));\n\t\tconfig.setAllowCredentials(true);\n\t\tconfig.setMaxAge(3600L);\n\n\t\tUrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();\n\t\tsource.registerCorsConfiguration("/api/**", config);\n\t\treturn source;\n\t}\n}',
      'spring-webmvc',
      'CORS configuration bean using UrlBasedCorsConfigurationSource',
      CIK.Snippet),

    makeSnippet(monaco, 'MockMvcTest',
      '@WebMvcTest($1Controller.class)\nclass $1ControllerTest {\n\n\t@Autowired\n\tprivate MockMvc mockMvc;\n\n\t@MockBean\n\tprivate $1Service $2Service;\n\n\t@Autowired\n\tprivate ObjectMapper objectMapper;\n\n\t@Test\n\tvoid $3() throws Exception {\n\t\twhen($2Service.$4()).thenReturn($5);\n\n\t\tmockMvc.perform(get("/api/$6")\n\t\t\t\t.contentType(MediaType.APPLICATION_JSON))\n\t\t\t.andExpect(status().isOk())\n\t\t\t.andExpect(jsonPath("$[0].$7").value($8));\n\t}\n}',
      'spring-webmvc-test',
      'Full @WebMvcTest class with MockMvc, @MockBean and test method template',
      CIK.Snippet),

    makeSnippet(monaco, 'MockMvcPerform',
      'mockMvc.perform($1("/$2")\n\t\t.contentType(MediaType.APPLICATION_JSON)\n\t\t.content(objectMapper.writeValueAsString($3)))\n\t.andExpect(status().$4())\n\t.andExpect(jsonPath("$.$5").value($6));',
      'spring-webmvc-test',
      'MockMvc perform() chain for testing REST endpoints',
      CIK.Snippet),

    makeSnippet(monaco, 'MultipartUpload',
      '@PostMapping("/upload")\npublic ResponseEntity<String> uploadFile(\n\t\t@RequestParam("file") MultipartFile file) throws IOException {\n\tif (file.isEmpty()) {\n\t\treturn ResponseEntity.badRequest().body("File is empty");\n\t}\n\tString filename = StringUtils.cleanPath(file.getOriginalFilename());\n\tPath target = Paths.get("$1").resolve(filename);\n\tFiles.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);\n\treturn ResponseEntity.ok("Uploaded: " + filename);\n}',
      'spring-webmvc',
      'File upload endpoint using @RequestParam MultipartFile',
      CIK.Snippet),

    makeSnippet(monaco, 'RedirectFlash',
      'redirectAttributes.addFlashAttribute("$1", "$2");\nreturn "redirect:/$3";',
      'spring-webmvc',
      'Add flash attribute and redirect using RedirectAttributes',
      CIK.Snippet),

    makeSnippet(monaco, 'UriCreated',
      'URI location = UriComponentsBuilder\n\t.fromCurrentRequest()\n\t.path("/{id}")\n\t.buildAndExpand($1.getId())\n\t.toUri();\nreturn ResponseEntity.created(location).body($1);',
      'spring-webmvc',
      '201 Created ResponseEntity with Location header built from UriComponentsBuilder',
      CIK.Snippet),

    makeSnippet(monaco, 'InitBinder',
      '@InitBinder\npublic void initBinder(WebDataBinder binder) {\n\tbinder.registerCustomEditor(Date.class,\n\t\tnew CustomDateEditor(new SimpleDateFormat("$1"), true));\n}',
      'spring-webmvc',
      '@InitBinder method registering a custom property editor for data binding',
      CIK.Snippet),

    makeSnippet(monaco, 'BindingResultCheck',
      'if (bindingResult.hasErrors()) {\n\tMap<String, String> errors = new HashMap<>();\n\tbindingResult.getFieldErrors().forEach(e ->\n\t\terrors.put(e.getField(), e.getDefaultMessage()));\n\treturn ResponseEntity.badRequest().body(errors);\n}',
      'spring-webmvc',
      'Check BindingResult for validation errors and return 400 with field-error map',
      CIK.Snippet),

    makeSnippet(monaco, 'HttpServletRequestUsage',
      'String ipAddress   = request.getRemoteAddr();\nString userAgent   = request.getHeader("User-Agent");\nString method      = request.getMethod();\nString requestUri  = request.getRequestURI();\nString queryString = request.getQueryString();\nHttpSession session = request.getSession(false);',
      'spring-webmvc',
      'Common HttpServletRequest usage patterns (IP, headers, method, URI, session)',
      CIK.Snippet),

    makeSnippet(monaco, 'HttpHeadersBuilder',
      'HttpHeaders headers = new HttpHeaders();\nheaders.setContentType(MediaType.APPLICATION_JSON);\nheaders.set("Authorization", "Bearer " + $1);\nreturn new ResponseEntity<>($2, headers, HttpStatus.$3);',
      'spring-webmvc',
      'Build custom HttpHeaders and return ResponseEntity with them',
      CIK.Snippet),

    makeSnippet(monaco, 'ModelAndView',
      'ModelAndView mav = new ModelAndView("$1");\nmav.addObject("$2", $3);\nreturn mav;',
      'spring-webmvc',
      'Create and return a ModelAndView with view name and model attribute',
      CIK.Snippet),
  ];

  return [
    ...annotationItems,
    ...typeItems,
    ...snippets.map(s => ({ ...s, range: undefined as unknown as Monaco.IRange })),
  ];
}

// ─── Main registration function ────────────────────────────────────────────

let registered = false;

export function registerJavaCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.', '@', ' ', '\n'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const allItems = [
        ...getJavaKeywords(monaco),
        ...getJavaSnippets(monaco),
        ...getJavaMethodCompletions(monaco),
        ...getSpringAnnotations(monaco),
        ...getSpringWebMvcCompletions(monaco),
        ...getHibernateAnnotations(monaco),
        ...getSpringDataMethods(monaco),
        ...getSpringSnippets(monaco),
        ...getLombokAnnotations(monaco),
        ...getValidationAnnotations(monaco),
      ].map(item => ({ ...item, range }));

      return { suggestions: allItems };
    }
  });
}
