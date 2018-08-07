When this module is active, all full-text searches of your [ApostropheCMS](https://apostrophecms.org) site run through [Elasticsearch](https://www.elastic.co/products/elasticsearch), replacing the built-in MongoDB text search engine normally used by Apostrophe.

```
npm install apostrophe-elasticsearch
```

```javascript
// in app.js
modules: {
  'apostrophe-elasticsearch': {}
}
```

You can also configure custom boosts for various properties if present in the doc, decide what fields to index, and do much more, including passing options through to Elasticsearch. Here is a more complex configuration with all of the options in play:

```javascript
// in app.js
modules: {
  'apostrophe-elasticsearch': {
    // Default matches your shortName. Index names
    // will look like: myprojectaposdocsen (for en locale),
    // myprojectaposdocsfr (for fr locale), etc.
    baseName: 'myproject',

    // elasticsearch config options, please see:
    // https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/configuration.html#config-options
    elasticsearchOptions: {
      // This is the default
      host: 'localhost:9200'
    },

    // This is the default list of fields.
    fields: [ 'title', 'tags', 'lowSearchText', 'highSearchText' ],

    // Relative importance. Note that if you don't specify elasticsearch
    // does a rather good job figuring this out on its own.
    boosts: {
      tags: 50,
      title: 100,
      highSearchText: 10,
      lowSearchText: 1
    },

    // Simple shortcut to set the analyzer for all indexes.
    // Useful for single-language sites
    analyzer: 'french',

    // Shortcut to specify analyzers by locale (with apostrophe-workflow)
    analyzers: {
      master: 'french',
      fr: 'french',
      en: 'english'
    },

    // Becomes the elasticsearch `settings` property of each index
    indexSettings: {
      'analysis': {
        'analyzer': 'french'
      }
    },
    
    // Sets additional subproperties of the elasticsearch `settings` property
    // of the index, on a per-locale basis (for use with apostrophe-workflow)
    localeIndexSettings: {
      'en': {
        'analysis': {
          'analyzer': 'english'
        }
      }
    },
  }
}
```

> **"What are all these fields?"** `lowSearchText` contains all of the text of the doc, including rich text editor content, stripped of its markup. `highSearchText` contains only text in `string` and `tags` schema fields and is often boosted higher. Note that these will both contain `title`. However, further weighting things like `title` and `tags` yourself gives you more fine-grained control.

> **"What are the possible properties for `indexSettings` and `localeIndexSettings`?"** See the [elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules.html).

Now we need to index our existing docs in Elasticsearch. You must run this task at least once when adding this module:

```
node app apostrophe-elasticsearch:reindex
```

> **Apostrophe automatically updates the index as you edit docs.** You don't have to run this task all the time! However, if you change your `fields` option, change `indexSettings`, `analyzer`, `analyzers` or `localeIndexSettings`, or make significant edits that are invisible to Apostrophe via direct MongoDB updates, you should run this task again. You do not have to run it again when you change `boosts`.

Apostrophe will now use Elasticsearch to implement all searches that formerly used the built-in MongoDB text index:

* Sitewide search
* Anything else based on the `search()` cursor filter
* Anything else based on the `autocomplete()`  cursor filter
* Anything based on the `q` or `search` query parameters to an apostrophe-pieces-page (these invoke `search` via `queryToFilters`)
* Anything based on the `autocomplete` query parameter (this invokes `autocomplete` via `queryToFilters`)

> **All queries involving `search` or `autocomplete` will always sort their results in the order returned by Elasticsearch,** regardless of the `sort` cursor filter. Relevance is almost always the best sort order for results that include a free text search, and to do otherwise would require an exhaustive search of every match in Elasticsearch (potentially thousands of docs), just in case the last one scores higher according to some other criterion. Support for sorting on some other properties may be added later as more information is mirrored in Elasticsearch.

> **If a query cannot be completely satisfied by the first 10,000 matches in Elasticsearch, the results may be incomplete.** This is true even if the first 10,000 are simply being bypassed with `skip`. This is a built-in safeguard in Elasticsearch due to the memory and time impact of such searches. In rare cases, such as a search for a word mentioned in one document that is less relevant than the first 10,000 matching documents but is still the only relevant document according to MongoDB criteria also present in your query, this could impact the completeness of the response. However certain common categories of MongoDB query criteria are in fact replicated to Elasticsearch to mitigate this problem and improve performance (see below).

## Theory of operation

MongoDB and Elasticsearch both support many types of queries, including ranges, exact matches, and fuzzy matches. However, they are not identical query languages. Not every property is necessarily appropriate to copy to Elasticsearch. And Apostrophe queries that include text searches can also include arbitrarily complex MongoDB criteria on other properties.

For these reasons, we should not attempt to translate 100% of queries directly to Elasticsearch. However, we must not provide the user with results they should not see.

To meet both criteria, queries flow like this. For purposes of this discussion, `search` and `autocomplete` are equivalent.

* `search` is not present: query flows through the normal MongoDB query path and the remainder of these steps are not followed.
* `search` is present: the text search query parameter is given to Elasticsearch. In addition, a subset of additional criteria present in the query are given to Elasticsearch to narrow the results. Specifically, code inspired by that in [apostrophe-optimizer](https://npmjs.org/package/apostrophe-optimizer) is used to locate certain common "hard constraints" on the query, such as `type`, `tags` and `_id`. These are used to build a `filter` clause which does not affect relevance ranking. This improves performance by preventing Elasticsearch from exhaustively searching blog posts when a query is restricted to events in any case. Elasticsearch is asked for an initial batch of results, rather than all possible results.
* The results of this stage are fed through the normal MongoDB query path, without `$text` clauses, to ensure that additional MongoDB criteria present, such as permissions, are fully implemented.
* Additional batches of results are retrieved from the Elasticsearch stage and fed through the MongoDB query stage until the `limit` of the query is satisfied (if any) or no more results are obtained.
* Actual results are supplied to the caller via a wrapper that reimplements Apostrophe's `lowLevelMongoCursor` method for this use case.
* In this scheme, implementation of `toCount` requires an exhaustive query, however the projection is restricted to the `_id` only in both Elasticsearch and MongoDB to mitigate the impact.
* In this scheme, implementation of `toDistinct` also requires an exhaustive query, however the projection is limited to the property in question to mitigate the impact.
* `apostrophe-workflow` is present: for performance, and to avoid complex filter queries, a separate elasticsearch index is used for each locale. Documents that are not locale-specific are replicated to the indexes for all of the locales. 

This algorithm implements a "cross-domain join" between two different data stores, MongoDB and Elasticsearch. This is an inherently difficult problem to optimize completely, however the communication of a subset of the MongoDB criteria to Elasticsearch eliminates much of the overhead without the need to implement 100% of the MongoDB query language on top of Elasticsearch with perfect fidelity.
