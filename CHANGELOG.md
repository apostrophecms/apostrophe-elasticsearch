# Changelog

## 2.1.3

Better test for inappropriate values given to the `search` cursor filter method, with full unit testing.

## 2.1.2

Does not crash if `null` or `undefined` is passed to the `search` cursor filter method. Thanks to giuseppecm.

## 2.1.1

Fixed an oversight in the documentation which did not explain that the use of `addFields` is preferred over specifying `fields` in its entirety.

Also made sure the set of fields that are directly queried for exact matches to speed up queries are always indexed, even if they are left out of the `fields` option.

If you received no search results due to a combination of these issues, run the reindex task again and try those searches again.

## 2.1.0

Major performance and reliability improvements to the indexing procedure, especially the `apostrophe-elasticsearch:reindex` task. Batch operations are now used for better throughput, and when reindexing one locale is processed at a time to minimize resource contention between the different indexes. In addition, the reindex task now has a `--verbose` option that displays progress information, including an estimate of the remaining time. This estimate tends to be a bit optimistic because Elasticsearch does slow down somewhat as it fills up.

## 2.0.1

Documentation tweaks.

## 2.0.0

Initial release, with passing tests.
